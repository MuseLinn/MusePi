import { describe, expect, test } from "bun:test";
import { isUsageReport, parseUsageReport } from "./usage-card";

const REPORT = `\`\`\`text
Usage (2m ago)
Opencode Go
  Models with usage data
    opencode/deepseek-v4-flash
    opencode/deepseek-v4-pro
    opencode/kimi-k2.5
- 5 Hour limit
  Account 1: 4.00% used (96.0% left)
  █······················································································· 4%
  resets in 2h
- Weekly limit
  Account 2: 55.00% used (45.0% left)
  ████████████████████████████████···················································· 55%
  resets in 2d
- Monthly limit
  Account 3: 92.00% used (8.0% left)
  ████████████████████████████████████████████████████████·························· 92%
  resets in 17d
\`\`\``;

describe("usage-card parser", () => {
	test("detects a /usage report", () => {
		expect(isUsageReport(REPORT)).toBe(true);
		expect(isUsageReport("just a normal message")).toBe(false);
		expect(isUsageReport("Hello world")).toBe(false);
	});

	test("parses provider, models and limits", () => {
		const parsed = parseUsageReport(REPORT);
		expect(parsed).not.toBeNull();
		expect(parsed!.provider).toBe("Opencode Go");
		expect(parsed!.fetchedLabel).toBe("2m ago");
		expect(parsed!.models).toEqual(["opencode/deepseek-v4-flash", "opencode/deepseek-v4-pro", "opencode/kimi-k2.5"]);
		expect(parsed!.limits).toHaveLength(3);
		const [fiveHour, weekly, monthly] = parsed!.limits;
		expect(fiveHour!.label).toBe("5 Hour limit");
		expect(fiveHour!.account).toBe("Account 1");
		expect(fiveHour!.usedPercent).toBeCloseTo(4);
		expect(fiveHour!.leftPercent).toBeCloseTo(96);
		expect(fiveHour!.resetsIn).toBe("2h");
		expect(weekly!.usedPercent).toBeCloseTo(55);
		expect(weekly!.resetsIn).toBe("2d");
		expect(monthly!.usedPercent).toBeCloseTo(92);
		expect(monthly!.resetsIn).toBe("17d");
	});

	test("token-tally fallback: detected but not parseable (renders as text)", () => {
		const fallback = "```text\nUsage\nInput tokens: 12\n```";
		expect(isUsageReport(fallback)).toBe(true); // fence + Usage header
		expect(parseUsageReport(fallback)).toBeNull(); // no models/limits → not a report card
		expect(parseUsageReport("not a report")).toBeNull();
	});

	test("detects and parses a fence-less report (plain assistant text)", () => {
		const plain = `Usage (2m ago)
Opencode Go
  Models with usage data
    opencode-go/deepseek-v4-flash
- 5 Hour limit
  account 1: 5.00% used (95.0% left)
  [ 1m ] [22m ] [39m ] 5%
  resets in 2h`;
		expect(isUsageReport(plain)).toBe(true);
		const parsed = parseUsageReport(plain);
		expect(parsed).not.toBeNull();
		expect(parsed!.provider).toBe("Opencode Go");
		expect(parsed!.models).toEqual(["opencode-go/deepseek-v4-flash"]);
		expect(parsed!.limits[0]!.usedPercent).toBeCloseTo(5);
		expect(parsed!.limits[0]!.resetsIn).toBe("2h");
	});

	test("ordinary prose mentioning usage is NOT a report", () => {
		expect(isUsageReport("Usage of the API went up this month")).toBe(false);
		expect(isUsageReport("Please explain how limits work")).toBe(false);
	});

	test("strips ANSI SGR codes (TUI panel output lands verbatim in the GUI)", () => {
		const ansi = `\x1b[39mUsage (5m ago)\x1b[0m
\x1b[39mOpencode Go\x1b[0m
  Models with usage data
    opencode-go/deepseek-v4-flash
\x1b[36m- 5 Hour limit\x1b[0m
  account 1: 5.00% used (95.0% left)
  \x1b[39m] [39m [1m\x1b[22m [39m] 5%
  resets in 2h`;
		expect(isUsageReport(ansi)).toBe(true);
		const parsed = parseUsageReport(ansi);
		expect(parsed).not.toBeNull();
		expect(parsed!.provider).toBe("Opencode Go");
		expect(parsed!.limits[0]!.label).toBe("5 Hour limit");
		expect(parsed!.limits[0]!.usedPercent).toBeCloseTo(5);
		expect(parsed!.limits[0]!.resetsIn).toBe("2h");
	});
});
