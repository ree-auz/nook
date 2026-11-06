# Lists processes whose current directory is inside -Root, or that hold a file below it.
# Prints JSON: { processes: [{ pid, name, reasons }], inaccessible, handleScan }.
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') { throw 'Windows x64 is required for the process scan' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
namespace Nook {
 public class DirectoryProcess { public int pid; public string name; }
 public class DirectoryScan { public DirectoryProcess[] processes; public int inaccessible; }
 public static class DirectoryInspector {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, byte[] info, int size, out int returned);
  static byte[] Read(IntPtr process, long address, int size) {
   byte[] data = new byte[size]; IntPtr read;
   if (!ReadProcessMemory(process, new IntPtr(address), data, new IntPtr(size), out read) || read.ToInt64() != size) throw new InvalidOperationException();
   return data;
  }
  public static DirectoryScan Scan(string root) {
   string target = Path.GetFullPath(root).TrimEnd('\\');
   var found = new List<DirectoryProcess>(); int unavailable = 0;
   foreach (Process process in Process.GetProcesses()) {
    using (process) {
     IntPtr handle = OpenProcess(0x410, false, process.Id);
     if (handle == IntPtr.Zero) { unavailable++; continue; }
     try {
      bool wow64;
      if (!IsWow64Process(handle, out wow64) || wow64) { unavailable++; continue; }
      byte[] info = new byte[48]; int returned;
      if (NtQueryInformationProcess(handle, 0, info, info.Length, out returned) != 0) { unavailable++; continue; }
      long peb = BitConverter.ToInt64(info, 8);
      long parameters = BitConverter.ToInt64(Read(handle, peb + 0x20, 8), 0);
      // 64-bit RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath.
      byte[] current = Read(handle, parameters + 0x38, 16);
      int length = BitConverter.ToUInt16(current, 0);
      if (length == 0 || length > 32766 || length % 2 != 0) continue;
      string cwd = System.Text.Encoding.Unicode.GetString(Read(handle, BitConverter.ToInt64(current, 8), length)).TrimEnd('\\');
      if (cwd.StartsWith(@"\\?\", StringComparison.Ordinal)) cwd = cwd.Substring(4);
      if (cwd.Equals(target, StringComparison.OrdinalIgnoreCase) || cwd.StartsWith(target + "\\", StringComparison.OrdinalIgnoreCase))
       found.Add(new DirectoryProcess { pid = process.Id, name = process.ProcessName });
     } catch { unavailable++; }
     finally { CloseHandle(handle); }
    }
   }
   return new DirectoryScan { processes = found.ToArray(), inaccessible = unavailable };
  }
 }
 public static class RestartManager {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo {
   public UniqueProcess process;
   [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string appName;
   [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string serviceName;
   public uint appType; public uint status; public uint session; [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, System.Text.StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, IntPtr services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static int[] Holding(string[] files) {
   if (files.Length == 0) return new int[0];
   uint handle; var key = new System.Text.StringBuilder(64);
   int code = RmStartSession(out handle, 0, key);
   if (code != 0) throw new InvalidOperationException("Restart Manager start failed: " + code);
   try {
    for (int offset = 0; offset < files.Length; offset += 100) {
     int length = Math.Min(100, files.Length - offset); var batch = new string[length];
     Array.Copy(files, offset, batch, 0, length);
     code = RmRegisterResources(handle, (uint)length, batch, 0, IntPtr.Zero, 0, IntPtr.Zero);
     if (code != 0) throw new InvalidOperationException("Restart Manager register failed: " + code);
    }
    uint needed = 0, count = 0, reasons = 0;
    code = RmGetList(handle, out needed, ref count, null, ref reasons);
    if (code == 0) return new int[0];
    if (code != 234) throw new InvalidOperationException("Restart Manager list failed: " + code);
    var info = new ProcessInfo[needed]; count = needed;
    code = RmGetList(handle, out needed, ref count, info, ref reasons);
    if (code != 0) throw new InvalidOperationException("Restart Manager list failed: " + code);
    var ids = new HashSet<int>();
    for (int i = 0; i < count; i++) ids.Add(info[i].process.pid);
    var result = new int[ids.Count]; ids.CopyTo(result); return result;
   } finally { RmEndSession(handle); }
  }
 }
}
'@
$scan = [Nook.DirectoryInspector]::Scan($Root)
$found = @{}
foreach ($item in $scan.processes) {
  $found[$item.pid] = [ordered]@{ pid = $item.pid; name = $item.name; reasons = @('working directory') }
}
function Add-Occupant([int]$id, [string]$reason) {
  if (-not $found.ContainsKey($id)) {
    try {
      $process = Get-Process -Id $id -ErrorAction Stop
      $found[$id] = [ordered]@{ pid = $id; name = $process.ProcessName; reasons = @($reason) }
    } catch { return }
  } elseif ($reason -notin $found[$id].reasons) {
    $found[$id].reasons += $reason
  }
}
# Dependency and VCS folders hold tens of thousands of files, which makes the
# Restart Manager check take minutes. A program using them also has its working
# directory in the workspace, which the scan above already catches.
$skip = @('node_modules', '.git', '.pnpm-store', '.venv', 'venv', '__pycache__', 'target', '.gradle')
function Get-WorkspaceFiles([string]$dir) {
  try { $entries = [System.IO.Directory]::EnumerateFileSystemEntries($dir) } catch { return }
  foreach ($entry in $entries) {
    try { $attributes = [System.IO.File]::GetAttributes($entry) } catch { continue }
    if ($attributes -band [System.IO.FileAttributes]::Directory) {
      if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
      if ($skip -contains [System.IO.Path]::GetFileName($entry)) { continue }
      Get-WorkspaceFiles $entry
    } else {
      $entry
    }
  }
}
$files = @(Get-WorkspaceFiles $Root)
try {
  foreach ($id in [Nook.RestartManager]::Holding($files)) { Add-Occupant $id 'open file' }
  $handleScan = 'Restart Manager'
} catch {
  $handleScan = "Restart Manager unavailable: $($_.Exception.Message)"
}
$handleTool = Get-Command handle.exe -ErrorAction SilentlyContinue
if ($handleTool) {
  try {
    $handleOutput = & $handleTool.Source -nobanner -accepteula $Root 2>$null
    foreach ($line in $handleOutput) {
      if ($line -match '^\S.+?\s+pid:\s*(\d+)\s+') { Add-Occupant ([int]$Matches[1]) 'open file' }
    }
    $handleScan += ' + handle.exe'
  } catch { $handleScan += ' (handle.exe unavailable)' }
}
[pscustomobject]@{ processes = @($found.Values); inaccessible = $scan.inaccessible; handleScan = $handleScan } | ConvertTo-Json -Depth 5 -Compress
