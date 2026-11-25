import { describe, expect, it } from "vitest";
import { parseWhen } from "./executors/apps-whatsapp-web";

describe("parseWhen (reminder times)", () => {
  // Thursday 26 Nov 2026, 15:00 in India (09:30 UTC).
  const now = new Date("2026-11-26T09:30:00Z");
  const tz = "Asia/Kolkata";
  it("reads dates, today/tomorrow, am/pm and 'in N hours' in the given time zone", () => {
    expect(parseWhen("2026-11-28 09:00", now, tz).toISOString()).toBe("2026-11-28T03:30:00.000Z");
    expect(parseWhen("2026-11-28", now, tz).toISOString()).toBe("2026-11-28T03:30:00.000Z");
    expect(parseWhen("2026-11-28 6:30 pm", now, tz).toISOString()).toBe("2026-11-28T13:00:00.000Z");
    expect(parseWhen("tomorrow 9am", now, tz).toISOString()).toBe("2026-11-27T03:30:00.000Z");
    expect(parseWhen("Tomorrow at 12am", now, tz).toISOString()).toBe("2026-11-26T18:30:00.000Z");
    expect(parseWhen("today 18:30", now, tz).toISOString()).toBe("2026-11-26T13:00:00.000Z");
    expect(parseWhen("in 2 hours", now, tz).toISOString()).toBe("2026-11-26T11:30:00.000Z");
    expect(parseWhen("in 30 min", now, tz).toISOString()).toBe("2026-11-26T10:00:00.000Z");
    expect(parseWhen("in 1 week", now, tz).toISOString()).toBe("2026-12-03T09:30:00.000Z");
    expect(parseWhen("2026-11-28T09:00:00+05:30", now, "UTC").toISOString()).toBe("2026-11-28T03:30:00.000Z");
    expect(parseWhen("2026-11-28 09:00", now, "UTC").toISOString()).toBe("2026-11-28T09:00:00.000Z");
    // Across a daylight-saving change.
    expect(parseWhen("2026-03-30 09:00", now, "Europe/London").toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });
  it("explains what it can't read", () => {
    expect(() => parseWhen("next friday-ish", now, tz)).toThrow(/Couldn't read/);
    expect(() => parseWhen("2026-11-28 25:00", now, tz)).toThrow(/isn't a valid time/);
    expect(() => parseWhen("", now, tz)).toThrow(/empty/);
  });
});
