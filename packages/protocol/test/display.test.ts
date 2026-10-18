import { describe, expect, it } from "vitest";
import { backendLabel, formatPercent, formatTime } from "../src/index.js";

describe("backendLabel", () => {
  it("names the two backends and leaves an unknown id as it is", () => {
    expect(backendLabel("codex-appserver")).toBe("Codex");
    expect(backendLabel("claude-agent")).toBe("Claude");
    expect(backendLabel("cursor-acp")).toBe("cursor-acp");
  });
});

describe("formatTime", () => {
  const timeZone = "Asia/Shanghai";
  const now = Date.parse("2026-10-18T06:30:00Z"); // 14:30 in Shanghai
  it("writes hours and minutes for today, the date this year and the year before that, never seconds", () => {
    expect(formatTime(Date.parse("2026-10-18T00:05:09Z"), { now, timeZone })).toBe("08:05");
    expect(formatTime(Date.parse("2026-10-17T15:59:00Z"), { now, timeZone })).toBe("10月17日 23:59");
    // The year is the one in the time zone: 16:00 UTC on 31 December is already 1 January in Shanghai.
    expect(formatTime(Date.parse("2025-12-31T16:00:00Z"), { now, timeZone })).toBe("1月1日 00:00");
    expect(formatTime(Date.parse("2025-03-02T01:02:00Z"), { now, timeZone })).toBe("2025年3月2日 09:02");
  });
  it("takes an ISO string or a Date, and keeps a string that is not a time", () => {
    expect(formatTime("2026-10-18T06:00:00.000Z", { now, timeZone })).toBe("14:00");
    expect(formatTime(new Date("2026-10-18T06:00:00Z"), { now, timeZone })).toBe("14:00");
    expect(formatTime("不是时间", { now, timeZone })).toBe("不是时间");
    expect(formatTime(Number.NaN, { now, timeZone })).toBe("时间未知");
  });
  it("writes 时间未知 for no time instead of 1970", () => {
    for (const value of [null, undefined, "", 0, new Date(0)]) expect(formatTime(value, { now, timeZone })).toBe("时间未知");
  });
  it("counts midnight as 00, not 24", () => {
    expect(formatTime(Date.parse("2026-10-17T16:00:00Z"), { now, timeZone })).toBe("00:00");
  });
});

describe("formatPercent", () => {
  it("rounds to whole percent", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(41.6)).toBe("42%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(120)).toBe("120%");
  });
  it("does not round a little down to 0% or nearly full up to 100%", () => {
    expect(formatPercent(0.3)).toBe("<1%");
    expect(formatPercent(99.6)).toBe(">99%");
  });
  it("shows a dash for a missing number", () => {
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
