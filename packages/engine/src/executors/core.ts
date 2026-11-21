import type { Assignment, KeyValuePair } from "@conduit/nodes";
import type { EngineServices, Executor, Item } from "../types";
import { StepError } from "../types";
import { parseJsonParam, toNumber, toObject, toText } from "../values";

function pairs(v: unknown): KeyValuePair[] {
  return Array.isArray(v) ? (v as KeyValuePair[]).filter((r) => toText(r.key).trim() !== "") : [];
}

export const httpExecutor: Executor = async (ctx) => {
  const out: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    out.push({ json: await performHttp(ctx.params(i), ctx.services) });
  }
  return { outputs: { main: out } };
};

/** Builds and sends one HTTP request from resolved parameters. Shared by the HTTP step and the agent HTTP tool. */
export async function performHttp(p: Record<string, unknown>, services: EngineServices): Promise<Record<string, unknown>> {
  {
    const method = toText(p.method || "GET").toUpperCase();
    let url: URL;
    try {
      url = new URL(toText(p.url));
    } catch {
      throw new StepError(`"${toText(p.url)}" is not a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new StepError("Only http and https URLs are allowed");
    for (const q of pairs(p.query)) url.searchParams.append(toText(q.key), toText(q.value));
    const headers: Record<string, string> = {};
    for (const h of pairs(p.headers)) headers[toText(h.key)] = toText(h.value);
    const sensitiveHeaders: string[] = [];
    if (p.authentication === "credential") {
      if (!services.integrations) throw new StepError("Connected apps aren't set up on this server");
      const id = toText(p.credential);
      if (!id) throw new StepError("Choose the API key to use");
      const { headerName, headerValue } = await services.integrations.credential(id, "httpHeader");
      headers[headerName!] = headerValue!;
      sensitiveHeaders.push(headerName!.toLowerCase());
    }

    let body: string | undefined;
    const sendsBody = method !== "GET" && method !== "HEAD";
    if (sendsBody && p.bodyType === "json") {
      const parsed = parseJsonParam(p.jsonBody, "JSON body");
      if (parsed !== undefined) {
        body = JSON.stringify(parsed);
        headers["content-type"] ??= "application/json";
      }
    } else if (sendsBody && p.bodyType === "form") {
      body = new URLSearchParams(pairs(p.formBody).map((r) => [toText(r.key), toText(r.value)])).toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    } else if (sendsBody && p.bodyType === "text") {
      body = toText(p.textBody);
      headers["content-type"] ??= "text/plain";
    }

    const timeoutMs = Math.min(300, Math.max(1, toNumber(p.timeoutSeconds ?? 30, "Timeout"))) * 1000;
    const res = await services.http({ method, url: url.toString(), headers, body, timeoutMs, sensitiveHeaders });
    if (p.failOnErrorStatus !== false && res.status >= 400) {
      const detail = typeof res.body === "string" ? res.body.slice(0, 200) : JSON.stringify(res.body)?.slice(0, 200);
      throw new StepError(`Request failed with status ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return { status: res.status, headers: res.headers, body: res.body as unknown };
  }
}

export const codeExecutor: Executor = async (ctx) => {
  const code = toText(ctx.node.parameters.code);
  if (!code.trim()) throw new StepError("The code is empty");
  const mode = ctx.node.parameters.mode === "all" ? "all" : "perItem";
  const res = await ctx.services.runCode({ code, mode, items: ctx.items });
  for (const l of res.logs) ctx.log(l);
  return { outputs: { main: res.items.map((json) => ({ json })) } };
};

function convert(value: unknown, type: Assignment["type"], name: string): unknown {
  switch (type) {
    case "number":
      return value === "" || value === undefined ? null : toNumber(value, `Field "${name}"`);
    case "boolean":
      return value === true || value === "true" || value === 1 || value === "1";
    case "json":
      return typeof value === "string" ? parseJsonParam(value, `Field "${name}"`) ?? null : value ?? null;
    default:
      return value === undefined || value === null ? "" : typeof value === "string" ? value : toText(value);
  }
}

export const setExecutor: Executor = (ctx) => {
  const keep = ctx.node.parameters.keepOthers !== false;
  return {
    outputs: {
      main: ctx.items.map((item, i) => {
        const p = ctx.params(i);
        const rows = (p.assignments as Assignment[]) ?? [];
        const json: Record<string, unknown> = keep ? { ...item.json } : {};
        for (const r of rows) {
          const name = toText(r.name).trim();
          if (name) json[name] = convert(r.value, r.type, name);
        }
        return { json };
      }),
    },
  };
};

export const respondExecutor: Executor = (ctx) => {
  if (!ctx.state.response) {
    const p = ctx.params(0);
    const headers: Record<string, string> = {};
    for (const h of pairs(p.headers)) headers[toText(h.key).toLowerCase()] = toText(h.value);
    const status = toNumber(p.status ?? 200, "Status code");
    if (status < 100 || status > 599) throw new StepError("Status code must be between 100 and 599");
    ctx.state.response = { status, headers, body: parseJsonParam(p.body, "Body") ?? null };
  }
  return { outputs: { main: ctx.items } };
};

export const executeWorkflowExecutor: Executor = async (ctx) => {
  const p = ctx.params(0);
  const workflowId = toText(p.workflowId);
  if (!workflowId) throw new StepError("Choose a workflow to run");
  const input = parseJsonParam(p.input, "Input");
  const wait = p.waitForResult !== false;
  const results = await ctx.services.executeWorkflow({ workflowId, input: input ?? {}, waitForResult: wait });
  if (!wait) return { outputs: { main: ctx.items } };
  return { outputs: { main: results.length ? results.map((r) => ({ json: { result: r.json } })) : [{ json: { result: null } }] } };
};

export { toObject };
