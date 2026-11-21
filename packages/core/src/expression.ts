/**
 * Data references inside node parameters.
 *
 * A parameter value is a plain string that may embed references:
 *
 *   ${['$input']['customer']['email']}   current item from the directly connected upstream node
 *   ${['node-id']['items']['0']['sku']}   output of a specific upstream node, by node ID
 *
 * Path segments are always quoted strings; numeric segments index arrays. When a
 * whole parameter is exactly one reference, resolution keeps the referenced value's
 * type (object, number, ...). Otherwise references are interpolated into text.
 *
 * Legacy `{{ a.b }}` mustache paths are accepted as an alias for `${['$input']['a']['b']}`.
 * JavaScript evaluation inside expressions is a runtime (sandbox) concern and is not
 * handled here.
 */

export const INPUT_SOURCE = "$input";

export interface TextPart {
  kind: "text";
  value: string;
}

export interface RefPart {
  kind: "ref";
  /** `$input` or an upstream node ID. */
  source: string;
  path: string[];
  raw: string;
  start: number;
  end: number;
}

export interface InvalidPart {
  kind: "invalid";
  raw: string;
  message: string;
  start: number;
  end: number;
}

export type TemplatePart = TextPart | RefPart | InvalidPart;

const SEGMENT = /\['((?:[^'\\]|\\.)*)'\]/y;

function unescapeSegment(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

export function escapeSegment(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Builds the canonical reference string for a source and path. */
export function buildReference(source: string, path: readonly (string | number)[] = []): string {
  return "${" + [source, ...path].map((p) => `['${escapeSegment(String(p))}']`).join("") + "}";
}

/** Splits a parameter string into text, references and invalid fragments. */
export function parseTemplate(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = "";
  let i = 0;
  const flushText = () => {
    if (text) parts.push({ kind: "text", value: text });
    text = "";
  };

  while (i < input.length) {
    if (input.startsWith("${", i)) {
      const start = i;
      let j = i + 2;
      const segments: string[] = [];
      SEGMENT.lastIndex = j;
      let m: RegExpExecArray | null;
      while ((m = SEGMENT.exec(input))) {
        segments.push(unescapeSegment(m[1]!));
        j = SEGMENT.lastIndex;
      }
      if (input[j] === "}" && segments.length > 0) {
        flushText();
        const [source, ...path] = segments;
        parts.push({ kind: "ref", source: source!, path, raw: input.slice(start, j + 1), start, end: j + 1 });
        i = j + 1;
        continue;
      }
      const close = input.indexOf("}", i);
      const end = close === -1 ? input.length : close + 1;
      flushText();
      parts.push({
        kind: "invalid",
        raw: input.slice(start, end),
        message: "Use the form ${['node-id']['field']}",
        start,
        end,
      });
      i = end;
      continue;
    }
    if (input.startsWith("{{", i) && !input.startsWith("={{", i - 1)) {
      const close = input.indexOf("}}", i + 2);
      if (close !== -1) {
        const body = input.slice(i + 2, close).trim();
        if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(body)) {
          flushText();
          parts.push({
            kind: "ref",
            source: INPUT_SOURCE,
            path: body.split("."),
            raw: input.slice(i, close + 2),
            start: i,
            end: close + 2,
          });
          i = close + 2;
          continue;
        }
      }
    }
    text += input[i];
    i++;
  }
  flushText();
  return parts;
}

export function hasReferences(value: unknown): boolean {
  return typeof value === "string" && parseTemplate(value).some((p) => p.kind !== "text");
}

/** All references used anywhere inside a parameters object (deep). */
export function collectReferences(value: unknown, out: RefPart[] = []): RefPart[] {
  if (typeof value === "string") {
    for (const p of parseTemplate(value)) if (p.kind === "ref") out.push(p);
  } else if (Array.isArray(value)) {
    for (const v of value) collectReferences(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectReferences(v, out);
  }
  return out;
}

export function getPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return seg === "length" ? cur.length : undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export interface ResolveContext {
  /** Current item of the directly connected upstream node. */
  input?: unknown;
  /** Current item of each upstream node, by node ID. */
  nodes: Record<string, unknown>;
}

export interface ResolveResult {
  value: unknown;
  /** References that point to unknown sources or missing fields. */
  missing: string[];
  invalid: string[];
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function lookup(ref: RefPart, ctx: ResolveContext): { found: boolean; value: unknown } {
  const root = ref.source === INPUT_SOURCE ? ctx.input : ctx.nodes[ref.source];
  const known = ref.source === INPUT_SOURCE ? ctx.input !== undefined : ref.source in ctx.nodes;
  if (!known) return { found: false, value: undefined };
  const value = getPath(root, ref.path);
  return { found: value !== undefined, value };
}

/** Resolves references in one parameter string. Non-strings are returned unchanged. */
export function resolveTemplate(template: unknown, ctx: ResolveContext): ResolveResult {
  if (typeof template !== "string") return { value: template, missing: [], invalid: [] };
  const parts = parseTemplate(template);
  const missing: string[] = [];
  const invalid: string[] = [];
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.kind === "ref") {
    const r = lookup(only, ctx);
    if (!r.found) missing.push(only.raw);
    return { value: r.value, missing, invalid };
  }
  let out = "";
  for (const p of parts) {
    if (p.kind === "text") out += p.value;
    else if (p.kind === "invalid") {
      invalid.push(p.raw);
      out += p.raw;
    } else {
      const r = lookup(p, ctx);
      if (!r.found) missing.push(p.raw);
      out += stringify(r.value);
    }
  }
  return { value: out, missing, invalid };
}

/** Resolves every string inside a parameters object (deep), preserving structure. */
export function resolveParameters<T>(params: T, ctx: ResolveContext): { value: T; missing: string[]; invalid: string[] } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = resolveTemplate(v, ctx);
      missing.push(...r.missing);
      invalid.push(...r.invalid);
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(params) as T, missing, invalid };
}
