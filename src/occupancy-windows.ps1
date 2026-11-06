# Lists processes whose current directory is inside -Root.
# Prints JSON: { processes: [{ pid, name, reasons }], inaccessible }.
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
}
'@
$scan = [Nook.DirectoryInspector]::Scan($Root)
$processes = @($scan.processes | ForEach-Object { [ordered]@{ pid = $_.pid; name = $_.name; reasons = @('working directory') } })
[pscustomobject]@{ processes = $processes; inaccessible = $scan.inaccessible } | ConvertTo-Json -Depth 5 -Compress
