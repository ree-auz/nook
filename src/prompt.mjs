import { createInterface } from "node:readline/promises";
import { NookError } from "./errors.mjs";

/**
 * Asks questions on the terminal. With `yes`, every question takes its default.
 * Without a terminal and without `yes`, asking is an error, so scripts never hang.
 */
export function createPrompter({ yes = false, input = process.stdin, output = process.stderr } = {}) {
  const interactive = Boolean(input.isTTY);

  async function raw(question) {
    if (!interactive)
      throw new NookError(`Needs an answer ("${question.trim()}"); run it in a terminal`);
    const rl = createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  return {
    yes,
    interactive,
    async ask(question, fallback = "") {
      if (yes) return fallback;
      const answer = await raw(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      return answer || fallback;
    },
    async confirm(question, fallback = false) {
      if (yes) return fallback;
      for (;;) {
        const answer = (await raw(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
        if (!answer) return fallback;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
      }
    },
    /** choices: [{ key, label }]; returns the chosen key. */
    async choose(question, choices, fallback) {
      if (yes) return fallback;
      output.write(`${question}\n`);
      choices.forEach((choice, index) =>
        output.write(`  ${index + 1}. ${choice.label}${choice.key === fallback ? " (default)" : ""}\n`),
      );
      for (;;) {
        const answer = await raw("Choose a number: ");
        if (!answer) return fallback;
        const picked = choices[Number(answer) - 1];
        if (picked) return picked.key;
      }
    },
  };
}

/** Splits "--a 'b c'" into ["--a", "b c"]. Supports single and double quotes. */
export function splitArgs(text) {
  const out = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new NookError(`Unclosed quote in: ${text}`);
  if (started) out.push(current);
  return out;
}

export function joinArgs(args) {
  return args.map((arg) => (/[\s"']/.test(arg) || arg === "" ? JSON.stringify(arg) : arg)).join(" ");
}
