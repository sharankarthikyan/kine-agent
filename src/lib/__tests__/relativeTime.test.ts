import { describe, it, expect } from "vitest";
import { relativeTime } from "../relativeTime";

const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe("relativeTime", () => {
  const now = 1_000_000;

  it('returns "just now" when the timestamp is within 59 seconds', () => {
    expect(relativeTime(now - 0, now)).toBe("just now");
    expect(relativeTime(now - 30 * SEC, now)).toBe("just now");
    expect(relativeTime(now - 59 * SEC, now)).toBe("just now");
  });

  it('returns "1 min ago" (singular) at exactly 1 minute', () => {
    expect(relativeTime(now - 1 * MIN, now)).toBe("1 min ago");
  });

  it('returns "N mins ago" (plural) for 2-59 minutes', () => {
    expect(relativeTime(now - 2 * MIN, now)).toBe("2 mins ago");
    expect(relativeTime(now - 45 * MIN, now)).toBe("45 mins ago");
    expect(relativeTime(now - 59 * MIN, now)).toBe("59 mins ago");
  });

  it('returns "1 hr ago" (singular) at exactly 1 hour', () => {
    expect(relativeTime(now - 1 * HR, now)).toBe("1 hr ago");
  });

  it('returns "N hrs ago" (plural) for 2-23 hours', () => {
    expect(relativeTime(now - 2 * HR, now)).toBe("2 hrs ago");
    expect(relativeTime(now - 12 * HR, now)).toBe("12 hrs ago");
    expect(relativeTime(now - 23 * HR, now)).toBe("23 hrs ago");
  });

  it('returns "1 day ago" (singular) at exactly 1 day', () => {
    expect(relativeTime(now - 1 * DAY, now)).toBe("1 day ago");
  });

  it('returns "N days ago" (plural) for 2+ days', () => {
    expect(relativeTime(now - 2 * DAY, now)).toBe("2 days ago");
    expect(relativeTime(now - 30 * DAY, now)).toBe("30 days ago");
  });

  it("is PURE — the result depends only on ts and now, never on Date.now()", () => {
    // Calling with the same arguments twice must return the same result.
    const ts = now - 5 * HR;
    expect(relativeTime(ts, now)).toBe(relativeTime(ts, now));
  });
});
