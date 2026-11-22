import type { ConditionGroup, SwitchCase } from "@conduit/nodes";
import type { Executor, Item } from "../types";
import { StepError } from "../types";
import { evaluateGroup, toNumber, toText } from "../values";

export const ifExecutor: Executor = (ctx) => {
  const t: Item[] = [];
  const f: Item[] = [];
  ctx.items.forEach((item, i) => {
    (evaluateGroup(ctx.params(i).conditions as ConditionGroup) ? t : f).push(item);
  });
  return { outputs: { true: t, false: f } };
};

export const filterExecutor: Executor = (ctx) => ({
  outputs: { main: ctx.items.filter((_, i) => evaluateGroup(ctx.params(i).conditions as ConditionGroup)) },
});

/** Lets through only items whose key wasn't seen in an earlier live run of this step. */
export const onlyNewExecutor: Executor = async (ctx) => {
  if (!ctx.services.seen) throw new StepError("“Only new items” isn't available here");
  const keys = ctx.items.map((_, i) => {
    const k = toText(ctx.params(i).key).trim();
    if (!k) throw new StepError(`Item ${i + 1} has an empty key. Pick a field that's always set, like a link or an ID.`);
    return k;
  });
  const { fresh, firstRun } = await ctx.services.seen.filterNew(ctx.node.id, keys);
  if (firstRun && ctx.node.parameters.firstRun !== "pass") return { outputs: { main: [] } };
  return { outputs: { main: ctx.items.filter((_, i) => fresh[i]) } };
};

export const switchExecutor: Executor = (ctx) => {
  const raw = ctx.node.parameters;
  const cases = Array.isArray(raw.cases) ? (raw.cases as SwitchCase[]) : [];
  const outputs: Record<string, Item[]> = Object.fromEntries(cases.map((c) => [`case-${c.id}`, [] as Item[]]));
  const fallback = raw.fallback !== false;
  if (fallback) outputs.fallback = [];
  ctx.items.forEach((item, i) => {
    const p = ctx.params(i);
    const value = toText(p.value);
    const resolvedCases = (p.cases as SwitchCase[]) ?? [];
    const hit = resolvedCases.find((c) => toText(c.value) === value);
    if (hit) outputs[`case-${hit.id}`]!.push(item);
    else if (fallback) outputs.fallback!.push(item);
  });
  return { outputs };
};

export const waitExecutor: Executor = (ctx) => {
  const p = ctx.params(0);
  const now = ctx.services.now();
  if (p.mode === "until") {
    const until = new Date(toText(p.until));
    if (Number.isNaN(until.getTime())) throw new StepError(`"${toText(p.until)}" is not a valid date and time`);
    return { wait: { until } };
  }
  const amount = toNumber(p.amount ?? 0, "Amount");
  if (amount < 0) throw new StepError("Amount can't be negative");
  const unitMs = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[String(p.unit ?? "seconds")] ?? 1000;
  return { wait: { until: new Date(now.getTime() + amount * unitMs) } };
};

/** Merge buffering is handled by the runner; this combines the two buffered inputs. */
export function combineMerge(mode: unknown, a: Item[] = [], b: Item[] = []): Item[] {
  if (mode === "byPosition") {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => ({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } }));
  }
  if (mode === "chooseA") return a;
  return [...a, ...b];
}
