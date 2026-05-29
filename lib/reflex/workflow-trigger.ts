/**
 * Workflow trigger grammar + matching (pure — no node/server deps, safe to
 * import anywhere). Extends the original `manual | hourly | daily | weekly`
 * presets with two families the autonomy plane needs:
 *
 *   - `every:<n><m|h|d>`   sub-hourly / custom interval since last run
 *                          (e.g. `every:5m`, `every:30m`, `every:2h`)
 *   - `at:HH:MM`           wall-clock, fires once a day at that local time
 *   - `at:<dow>@HH:MM`     wall-clock weekly (dow = mon|tue|…|sun)
 *
 * Interval forms (hourly/daily/weekly/every:) fire when enough time has passed
 * since the last run. Wall-clock forms (`at:`) fire when the clock has reached
 * the target time and the workflow hasn't already fired since that target —
 * so a missed tick (server asleep at the target) still catches up later that
 * day. Times are evaluated in the server's local timezone.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const FIXED_INTERVALS: Record<string, number> = {
  hourly: HOUR,
  daily: DAY,
  weekly: WEEK,
};

// JS getDay(): 0 = Sunday … 6 = Saturday.
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const EVERY_RE = /^every:(\d+)(m|h|d)$/i;
const AT_DAILY_RE = /^at:(\d{1,2}):(\d{2})$/;
const AT_WEEKLY_RE = /^at:(mon|tue|wed|thu|fri|sat|sun)@(\d{1,2}):(\d{2})$/i;

/** Custom interval (ms) for `every:<n><unit>`, or null if not that form. */
function everyIntervalMs(trigger: string): number | null {
  const m = EVERY_RE.exec(trigger);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  return n * (unit === "m" ? MINUTE : unit === "h" ? HOUR : DAY);
}

function wallClockDue(
  now: Date,
  lastFired: number | null,
  dow: number | null,
  hh: number,
  mm: number,
): boolean {
  if (hh > 23 || mm > 59) return false;
  if (dow !== null && now.getDay() !== dow) return false;
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  const targetMs = target.getTime();
  if (now.getTime() < targetMs) return false; // not yet time today
  if (lastFired !== null && lastFired >= targetMs) return false; // already fired
  return true;
}

/**
 * Should a workflow with this `trigger` fire now, given when it last fired
 * (ms epoch, or null if never)? `manual` and unrecognized triggers never fire.
 */
export function isTriggerDue(
  trigger: string,
  lastFired: number | null,
  now: Date,
): boolean {
  if (!trigger) return false;
  const t = trigger.trim();
  if (t === "manual") return false;

  const fixed = FIXED_INTERVALS[t];
  if (fixed != null) {
    return lastFired === null || now.getTime() - lastFired >= fixed;
  }

  const everyMs = everyIntervalMs(t);
  if (everyMs != null) {
    return lastFired === null || now.getTime() - lastFired >= everyMs;
  }

  const daily = AT_DAILY_RE.exec(t);
  if (daily) return wallClockDue(now, lastFired, null, +daily[1]!, +daily[2]!);

  const weekly = AT_WEEKLY_RE.exec(t);
  if (weekly) {
    const dow = DOW.indexOf(weekly[1]!.toLowerCase());
    return wallClockDue(now, lastFired, dow, +weekly[2]!, +weekly[3]!);
  }

  return false;
}

/** Whether a trigger string is well-formed (for manifest / schema validation). */
export function isValidTrigger(trigger: string): boolean {
  if (
    trigger === "manual" ||
    trigger === "hourly" ||
    trigger === "daily" ||
    trigger === "weekly"
  ) {
    return true;
  }
  if (everyIntervalMs(trigger) != null) return true;
  const daily = AT_DAILY_RE.exec(trigger);
  if (daily && +daily[1]! <= 23 && +daily[2]! <= 59) return true;
  const weekly = AT_WEEKLY_RE.exec(trigger);
  if (weekly && +weekly[2]! <= 23 && +weekly[3]! <= 59) return true;
  return false;
}

/** Short human label for a trigger (UI / logs). */
export function describeTrigger(trigger: string): string {
  if (FIXED_INTERVALS[trigger] || trigger === "manual") return trigger;
  const every = EVERY_RE.exec(trigger);
  if (every) return `every ${every[1]}${every[2]!.toLowerCase()}`;
  const daily = AT_DAILY_RE.exec(trigger);
  if (daily) return `daily at ${daily[1]!.padStart(2, "0")}:${daily[2]}`;
  const weekly = AT_WEEKLY_RE.exec(trigger);
  if (weekly) return `${weekly[1]!.toLowerCase()} at ${weekly[2]!.padStart(2, "0")}:${weekly[3]}`;
  return trigger;
}
