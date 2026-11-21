/**
 * Model-filled values for agent tools.
 *
 * A tool step's parameter can contain one or more placeholders the agent fills in
 * when it calls the tool:
 *
 *   ={{AI('city', `The city the user asked about`, 'string')}}
 *
 * Each distinct key becomes a property of the tool's input schema. When the agent
 * calls the tool, every placeholder is replaced by the argument value.
 */

export const AI_FILL_TYPES = ["string", "number", "boolean"] as const;
export type AiFillType = (typeof AI_FILL_TYPES)[number];

export interface AiFillSlot {
  key: string;
  description: string;
  type: AiFillType;
}

const PATTERN = /=\{\{\s*AI\(\s*'([A-Za-z_][A-Za-z0-9_]{0,63})'\s*,\s*`((?:[^`\\]|\\.)*)`\s*(?:,\s*'(string|number|boolean)'\s*)?\)\s*\}\}/g;

export function buildAiFill(key: string, description: string, type: AiFillType = "string"): string {
  return `={{AI('${key}', \`${description.replace(/[`\\]/g, "\\$&")}\`, '${type}')}}`;
}

/** Placeholders in one string. */
export function parseAiFills(value: string): Array<AiFillSlot & { raw: string }> {
  const out: Array<AiFillSlot & { raw: string }> = [];
  for (const m of value.matchAll(PATTERN)) {
    out.push({ key: m[1]!, description: m[2]!.replace(/\\(.)/g, "$1"), type: (m[3] as AiFillType) ?? "string", raw: m[0] });
  }
  return out;
}

/** Every distinct slot in a parameters object (deep). First description/type for a key wins. */
export function collectAiFills(params: unknown): AiFillSlot[] {
  const byKey = new Map<string, AiFillSlot>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const s of parseAiFills(v)) {
        if (!byKey.has(s.key)) byKey.set(s.key, { key: s.key, description: s.description, type: s.type });
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(params);
  return [...byKey.values()];
}

/**
 * Replaces placeholders with the agent's arguments. A string that is exactly one
 * placeholder takes the argument's own type; embedded placeholders are stringified.
 */
export function fillAiPlaceholders<T>(params: T, args: Record<string, unknown>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const slots = parseAiFills(v);
      if (!slots.length) return v;
      if (slots.length === 1 && slots[0]!.raw === v.trim()) return args[slots[0]!.key] ?? null;
      let out = v;
      for (const s of slots) {
        const a = args[s.key];
        out = out.split(s.raw).join(a === undefined || a === null ? "" : typeof a === "string" ? a : JSON.stringify(a));
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(params) as T;
}

/** JSON schema (strict-compatible) for a tool's model-filled inputs. */
export function aiFillSchema(slots: AiFillSlot[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(slots.map((s) => [s.key, { type: s.type, description: s.description }])),
    required: slots.map((s) => s.key),
    additionalProperties: false,
  };
}
