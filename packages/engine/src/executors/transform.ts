import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Executor, Item } from "../types";
import { StepError } from "../types";
import { parseJsonParam, toNumber, toText } from "../values";

function withResult(item: Item, field: unknown, value: unknown): Item {
  const name = toText(field).trim() || "result";
  return { json: { ...item.json, [name]: value } };
}

function perItem(fn: (p: Record<string, unknown>, item: Item) => unknown): Executor {
  return (ctx) => ({
    outputs: { main: ctx.items.map((item, i) => withResult(item, ctx.params(i).outputField, fn(ctx.params(i), item))) },
  });
}

export const textExecutor = perItem((p) => {
  const v = toText(p.value);
  switch (p.operation) {
    case "lower":
      return v.toLowerCase();
    case "upper":
      return v.toUpperCase();
    case "replace": {
      const search = toText(p.search);
      if (!search) throw new StepError("Find is required");
      return p.replaceAll === false ? v.replace(search, toText(p.replaceWith)) : v.split(search).join(toText(p.replaceWith));
    }
    case "split":
      return v.split(toText(p.separator ?? ","));
    case "slice": {
      const start = toNumber(p.start ?? 0, "Start index");
      const end = p.end === undefined || p.end === "" ? undefined : toNumber(p.end, "End index");
      return v.slice(start, end);
    }
    case "length":
      return v.length;
    default:
      return v.trim();
  }
});

export const mathExecutor = perItem((p) => {
  const a = toNumber(p.a, "Number");
  const b = () => toNumber(p.b, "Second number");
  switch (p.operation) {
    case "subtract":
      return a - b();
    case "multiply":
      return a * b();
    case "divide": {
      const d = b();
      if (d === 0) throw new StepError("Can't divide by zero");
      return a / d;
    }
    case "modulo":
      return a % b();
    case "power":
      return a ** b();
    case "round": {
      const f = 10 ** toNumber(p.decimals ?? 0, "Decimal places");
      return Math.round(a * f) / f;
    }
    case "floor":
      return Math.floor(a);
    case "ceil":
      return Math.ceil(a);
    case "abs":
      return Math.abs(a);
    default:
      return a + b();
  }
});

function zoned(d: Date, timeZone: string) {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
  } catch {
    throw new StepError(`Unknown time zone "${timeZone}"`);
  }
  return parts;
}

export function formatDate(d: Date, format: string, timeZone: string): string {
  if (!format.trim()) return d.toISOString();
  const p = zoned(d, timeZone);
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) =>
    ({ YYYY: p.year!, MM: p.month!, DD: p.day!, HH: p.hour!, mm: p.minute!, ss: p.second! })[t]!,
  );
}

function parseDate(v: unknown, label: string): Date {
  const d = v instanceof Date ? v : typeof v === "number" ? new Date(v) : new Date(toText(v));
  if (Number.isNaN(d.getTime())) throw new StepError(`${label} "${toText(v)}" is not a valid date`);
  return d;
}

const MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 } as const;

function shift(d: Date, amount: number, unit: string): Date {
  if (unit === "months" || unit === "years") {
    const r = new Date(d);
    r.setUTCMonth(r.getUTCMonth() + amount * (unit === "years" ? 12 : 1));
    return r;
  }
  const ms = MS[unit as keyof typeof MS];
  if (!ms) throw new StepError(`Unknown unit "${unit}"`);
  return new Date(d.getTime() + amount * ms);
}

export const dateExecutor: Executor = (ctx) => ({
  outputs: {
    main: ctx.items.map((item, i) => {
      const p = ctx.params(i);
      const tz = toText(p.timezone || "UTC");
      const fmt = toText(p.format ?? "");
      const unit = toText(p.unit || "days");
      let value: unknown;
      switch (p.operation) {
        case "now":
          value = formatDate(ctx.services.now(), fmt, tz);
          break;
        case "add":
        case "subtract": {
          const amount = toNumber(p.amount ?? 0, "Amount") * (p.operation === "subtract" ? -1 : 1);
          value = formatDate(shift(parseDate(p.date, "Date"), amount, unit), fmt, tz);
          break;
        }
        case "diff": {
          const a = parseDate(p.date, "Date");
          const b = parseDate(p.otherDate, "Compared with");
          const delta = a.getTime() - b.getTime();
          if (unit === "months" || unit === "years") {
            const months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
            value = unit === "years" ? Math.trunc(months / 12) : months;
          } else value = Math.trunc(delta / MS[unit as keyof typeof MS]);
          break;
        }
        default:
          value = formatDate(parseDate(p.date, "Date"), fmt, tz);
      }
      return withResult(item, p.outputField, value);
    }),
  },
});

export const cryptoExecutor = perItem((p) => {
  const v = toText(p.value);
  const enc = p.encoding === "base64" ? "base64" : "hex";
  switch (p.operation) {
    case "sha1":
    case "md5":
    case "sha256":
      return createHash(String(p.operation)).update(v).digest(enc);
    case "hmac-sha256": {
      const secret = toText(p.secret);
      if (!secret) throw new StepError("Secret is required");
      return createHmac("sha256", secret).update(v).digest(enc);
    }
    case "base64-encode":
      return Buffer.from(v, "utf8").toString("base64");
    case "base64-decode":
      return Buffer.from(v, "base64").toString("utf8");
    case "hex-encode":
      return Buffer.from(v, "utf8").toString("hex");
    case "uuid":
      return randomUUID();
    default:
      throw new StepError(`Unknown operation "${String(p.operation)}"`);
  }
});

export const jsonExecutor = perItem((p) => {
  if (p.operation === "stringify") return JSON.stringify(p.value, null, p.pretty ? 2 : undefined);
  return parseJsonParam(p.value, "Value") ?? null;
});

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  throw new StepError(`List must be a list (got ${JSON.stringify(v)?.slice(0, 80)})`);
}

function field(el: unknown, name: string): unknown {
  return el && typeof el === "object" ? (el as Record<string, unknown>)[name] : undefined;
}

export const listExecutor: Executor = (ctx) => {
  const out: Item[] = [];
  ctx.items.forEach((item, i) => {
    const p = ctx.params(i);
    const list = asList(p.list);
    const f = toText(p.field);
    if (p.operation === "split") {
      for (const el of list) out.push({ json: el && typeof el === "object" && !Array.isArray(el) ? (el as Record<string, unknown>) : { value: el } });
      return;
    }
    let value: unknown;
    switch (p.operation) {
      case "first":
        value = list[0] ?? null;
        break;
      case "last":
        value = list[list.length - 1] ?? null;
        break;
      case "unique": {
        const seen = new Set<string>();
        value = list.filter((x) => {
          const k = JSON.stringify(x);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        break;
      }
      case "sort": {
        const dir = p.direction === "desc" ? -1 : 1;
        value = [...list].sort((a, b) => {
          const x = f ? field(a, f) : a;
          const y = f ? field(b, f) : b;
          if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
          return toText(x).localeCompare(toText(y)) * dir;
        });
        break;
      }
      case "join":
        value = list.map(toText).join(toText(p.separator ?? ", "));
        break;
      case "pluck":
        if (!f) throw new StepError("Field is required");
        value = list.map((x) => field(x, f));
        break;
      default:
        value = list.length;
    }
    out.push(withResult(item, p.outputField, value));
  });
  return { outputs: { main: out } };
};
