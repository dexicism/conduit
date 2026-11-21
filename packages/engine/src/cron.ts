import { isValidCron } from "@conduit/nodes";

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function expandField(field: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let from = min;
    let to = max;
    if (range !== "*") {
      const [a, b] = range!.split("-");
      from = Number(a);
      to = b !== undefined ? Number(b) : stepStr ? max : from;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

interface Parsed {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function parse(expr: string): Parsed {
  if (!isValidCron(expr)) throw new Error(`Invalid cron expression "${expr}"`);
  const f = expr.trim().split(/\s+/);
  const dow = expandField(f[4]!, RANGES[4]!);
  if (dow.has(7)) dow.add(0);
  return {
    minute: expandField(f[0]!, RANGES[0]!),
    hour: expandField(f[1]!, RANGES[1]!),
    dom: expandField(f[2]!, RANGES[2]!),
    month: expandField(f[3]!, RANGES[3]!),
    dow,
    domAny: f[2] === "*",
    dowAny: f[4] === "*",
  };
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(d: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday as string] ?? 0,
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next minute strictly after `after` that matches the cron expression in `timeZone`. */
export function nextCronRun(expr: string, after: Date, timeZone = "UTC"): Date {
  const c = parse(expr);
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  let t = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const limit = after.getTime() + 366 * 24 * 3600 * 1000 * 2;
  while (t.getTime() < limit) {
    const p = zonedParts(t, tz);
    const domOk = c.dom.has(p.day);
    const dowOk = c.dow.has(p.weekday);
    // Standard cron: if both day fields are restricted, either may match.
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!c.month.has(p.month) || !dayOk) {
      t = new Date(t.getTime() + ((23 - p.hour) * 60 + (60 - p.minute)) * 60000); // next local midnight
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t = new Date(t.getTime() + (60 - p.minute) * 60000);
      continue;
    }
    if (c.minute.has(p.minute)) return t;
    t = new Date(t.getTime() + 60000);
  }
  throw new Error(`Cron expression "${expr}" never fires`);
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 } as const;

/** Next fire time for a Schedule trigger's parameters. */
export function nextScheduleRun(params: Record<string, unknown>, after: Date): Date {
  if (params.mode === "cron") return nextCronRun(String(params.cron ?? ""), after, String(params.timezone ?? "UTC"));
  const every = Math.max(1, Number(params.every ?? 1));
  const unit = (params.unit as keyof typeof UNIT_MS) ?? "hours";
  return new Date(after.getTime() + every * (UNIT_MS[unit] ?? UNIT_MS.hours));
}
