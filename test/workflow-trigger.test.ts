import { describe, it, expect } from "vitest";
import {
  isTriggerDue,
  isValidTrigger,
} from "@/lib/reflex/workflow-trigger";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("isTriggerDue — interval forms", () => {
  const now = new Date(2026, 0, 5, 12, 0, 0, 0); // fixed wall clock
  const t = now.getTime();

  it("manual never fires", () => {
    expect(isTriggerDue("manual", null, now)).toBe(false);
    expect(isTriggerDue("manual", t - DAY, now)).toBe(false);
  });

  it("hourly/daily/weekly fire when the interval elapsed", () => {
    expect(isTriggerDue("hourly", null, now)).toBe(true);
    expect(isTriggerDue("hourly", t - 30 * MIN, now)).toBe(false);
    expect(isTriggerDue("hourly", t - 61 * MIN, now)).toBe(true);
    expect(isTriggerDue("daily", t - 23 * HOUR, now)).toBe(false);
    expect(isTriggerDue("daily", t - 25 * HOUR, now)).toBe(true);
    expect(isTriggerDue("weekly", t - 6 * DAY, now)).toBe(false);
    expect(isTriggerDue("weekly", t - 8 * DAY, now)).toBe(true);
  });

  it("every:<n><unit> gives a custom interval", () => {
    expect(isTriggerDue("every:5m", null, now)).toBe(true);
    expect(isTriggerDue("every:5m", t - 4 * MIN, now)).toBe(false);
    expect(isTriggerDue("every:5m", t - 6 * MIN, now)).toBe(true);
    expect(isTriggerDue("every:2h", t - 1 * HOUR, now)).toBe(false);
    expect(isTriggerDue("every:2h", t - 3 * HOUR, now)).toBe(true);
    expect(isTriggerDue("every:0m", null, now)).toBe(false); // invalid → never
  });

  it("unknown triggers never fire", () => {
    expect(isTriggerDue("bogus", null, now)).toBe(false);
    expect(isTriggerDue("", null, now)).toBe(false);
  });
});

describe("isTriggerDue — wall-clock daily at:HH:MM", () => {
  it("fires once at/after the target, with catch-up", () => {
    const at0601 = new Date(2026, 0, 5, 6, 1, 0, 0);
    const yesterday = new Date(2026, 0, 4, 6, 0, 0, 0).getTime();
    // reached 06:00 today, last fired yesterday → due (also covers catch-up)
    expect(isTriggerDue("at:06:00", yesterday, at0601)).toBe(true);
    // already fired today at the target → not due again
    const today0600 = new Date(2026, 0, 5, 6, 0, 0, 0).getTime();
    expect(isTriggerDue("at:06:00", today0600, at0601)).toBe(false);
    // before the target time today → not yet
    const at0559 = new Date(2026, 0, 5, 5, 59, 0, 0);
    expect(isTriggerDue("at:06:00", yesterday, at0559)).toBe(false);
    // never fired, past target → due
    expect(isTriggerDue("at:06:00", null, at0601)).toBe(true);
  });
});

describe("isTriggerDue — wall-clock weekly at:<dow>@HH:MM", () => {
  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const now = new Date(2026, 0, 5, 9, 1, 0, 0);
  const weekAgo = now.getTime() - 7 * DAY;
  const today = DOW[now.getDay()]!;
  const otherDay = DOW[(now.getDay() + 1) % 7]!;

  it("fires only on the named weekday", () => {
    expect(isTriggerDue(`at:${today}@09:00`, weekAgo, now)).toBe(true);
    expect(isTriggerDue(`at:${otherDay}@09:00`, weekAgo, now)).toBe(false);
  });

  it("respects the time of day on the matching weekday", () => {
    const early = new Date(2026, 0, 5, 8, 59, 0, 0);
    expect(isTriggerDue(`at:${DOW[early.getDay()]}@09:00`, weekAgo, early)).toBe(
      false,
    );
  });
});

describe("isValidTrigger", () => {
  it("accepts presets and extended forms", () => {
    for (const t of ["manual", "hourly", "daily", "weekly", "every:5m", "every:2h", "every:1d", "at:06:00", "at:23:30", "at:mon@09:00", "at:SUN@18:00"]) {
      expect(isValidTrigger(t)).toBe(true);
    }
  });
  it("rejects malformed forms", () => {
    for (const t of ["", "bogus", "every:0m", "every:5x", "at:25:00", "at:06:60", "at:xyz@09:00", "at:6", "hourlyish"]) {
      expect(isValidTrigger(t)).toBe(false);
    }
  });
});
