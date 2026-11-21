import { StepError, type CodeRunResult, type Item } from "@conduit/engine";

export interface SandboxOptions {
  memoryLimitMb: number;
  timeoutMs: number;
}

const MAX_LOGS = 100;

/** Code run in the isolate. User code becomes the body of an async function. */
function wrap(code: string): string {
  return `
"use strict";
const __fmt = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
const console = {
  log: (...a) => __log(a.map(__fmt).join(" ")),
  info: (...a) => __log(a.map(__fmt).join(" ")),
  warn: (...a) => __log("warn: " + a.map(__fmt).join(" ")),
  error: (...a) => __log("error: " + a.map(__fmt).join(" ")),
};
const __items = JSON.parse(__input);
const __run = async (item, items) => {
${code}
};
(async () => {
  if (__mode === "all") return JSON.stringify((await __run(undefined, __items)) ?? null);
  const out = [];
  for (const it of __items) out.push((await __run(it, __items)) ?? null);
  return JSON.stringify(out);
})();
`;
}

function normalise(value: unknown, mode: "perItem" | "all"): Record<string, unknown>[] {
  const toObj = (v: unknown): Record<string, unknown> | null =>
    v === null || v === undefined ? null : typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  const out: Record<string, unknown>[] = [];
  const results = mode === "all" ? [value] : (value as unknown[]);
  for (const r of results) {
    if (Array.isArray(r)) for (const x of r) {
      const o = toObj(x);
      if (o) out.push(o);
    }
    else {
      const o = toObj(r);
      if (o) out.push(o);
    }
  }
  return out;
}

/**
 * Runs user JavaScript in a fresh V8 isolate: no Node APIs, no network, no file
 * system, a memory cap and a wall-clock timeout. Data goes in and out as JSON.
 */
export function createSandbox(opts: SandboxOptions) {
  return async function runCode(input: { code: string; mode: "perItem" | "all"; items: Item[] }): Promise<CodeRunResult> {
    const ivm = (await import("isolated-vm")).default;
    const isolate = new ivm.Isolate({ memoryLimit: opts.memoryLimitMb });
    const logs: string[] = [];
    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set("__input", JSON.stringify(input.items.map((i) => i.json)));
      await jail.set("__mode", input.mode);
      await jail.set(
        "__log",
        new ivm.Callback((msg: string) => {
          if (logs.length < MAX_LOGS) logs.push(String(msg).slice(0, 2000));
        }),
      );
      let script;
      try {
        script = await isolate.compileScript(wrap(input.code));
      } catch (err) {
        throw new StepError(`Syntax error: ${(err as Error).message}`);
      }
      const run = script.run(context, { timeout: opts.timeoutMs, promise: true, copy: true }) as Promise<string>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepError(`Code took longer than ${opts.timeoutMs / 1000}s`)), opts.timeoutMs + 250);
      });
      let json: string;
      try {
        json = await Promise.race([run, deadline]);
      } catch (err) {
        if (err instanceof StepError) throw err;
        const msg = (err as Error).message ?? String(err);
        if (/timed out/i.test(msg)) throw new StepError(`Code took longer than ${opts.timeoutMs / 1000}s`);
        if (/memory limit/i.test(msg) || isolate.isDisposed) throw new StepError(`Code used more than ${opts.memoryLimitMb} MB of memory`);
        throw new StepError(`Code error: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        throw new StepError("Code must return JSON-compatible data");
      }
      return { items: normalise(value, input.mode), logs };
    } finally {
      if (!isolate.isDisposed) isolate.dispose();
    }
  };
}
