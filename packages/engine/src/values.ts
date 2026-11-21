import type { ConditionGroup, ConditionRule } from "@conduit/nodes";
import { StepError } from "./types";

export function toNumber(v: unknown, label: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new StepError(`${label} must be a number (got ${JSON.stringify(v)})`);
}

export function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function toObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}

/** Parses a JSON parameter. References may already have produced an object. */
export function parseJsonParam(v: unknown, label: string): unknown {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new StepError(`${label} is not valid JSON`);
  }
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function asComparable(a: unknown, b: unknown): [unknown, unknown] {
  const na = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : NaN;
  const nb = typeof b === "number" ? b : typeof b === "string" && b.trim() !== "" ? Number(b) : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb)) return [na, nb];
  return [toText(a), toText(b)];
}

export function evaluateRule(rule: Pick<ConditionRule, "operator">, left: unknown, right: unknown): boolean {
  switch (rule.operator) {
    case "equals": {
      const [a, b] = asComparable(left, right);
      return a === b;
    }
    case "notEquals": {
      const [a, b] = asComparable(left, right);
      return a !== b;
    }
    case "contains":
      return Array.isArray(left) ? left.some((x) => toText(x) === toText(right)) : toText(left).includes(toText(right));
    case "notContains":
      return Array.isArray(left) ? !left.some((x) => toText(x) === toText(right)) : !toText(left).includes(toText(right));
    case "startsWith":
      return toText(left).startsWith(toText(right));
    case "endsWith":
      return toText(left).endsWith(toText(right));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(left, "Compared value");
      const b = toNumber(right, "Comparison value");
      return rule.operator === "gt" ? a > b : rule.operator === "gte" ? a >= b : rule.operator === "lt" ? a < b : a <= b;
    }
    case "matches":
      try {
        return new RegExp(toText(right)).test(toText(left));
      } catch {
        throw new StepError(`Invalid regular expression: ${toText(right)}`);
      }
    case "isEmpty":
      return isEmpty(left);
    case "isNotEmpty":
      return !isEmpty(left);
    case "isTrue":
      return left === true || left === "true" || left === 1;
    case "isFalse":
      return left === false || left === "false" || left === 0;
  }
}

/** Evaluates an already-resolved condition group. */
export function evaluateGroup(group: ConditionGroup | undefined): boolean {
  const rules = group?.rules ?? [];
  if (rules.length === 0) return true;
  const results = rules.map((r) => evaluateRule(r, r.left as unknown, r.right as unknown));
  return group?.combinator === "or" ? results.some(Boolean) : results.every(Boolean);
}
