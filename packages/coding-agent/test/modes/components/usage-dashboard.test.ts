import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@musepi/pi-ai";
import { UsageDashboard } from "@musepi/pi-coding-agent/modes/components/usage-dashboard";
import { getThemeByName, setThemeInstance } from "@musepi/pi-coding-agent/modes/theme/theme";

const DAY_MS = 24 * 60 * 60 * 1000;

function quotaReport(): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "codex-weekly",
				label: "Weekly",
				scope: { provider: "openai-codex", windowId: "weekly" },
				window: { id: "weekly", label: "weekly", resetsAt: Date.now() + 3 * DAY_MS },
				amount: { usedFraction: 0.25, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: "user@example.test" },
	};
}

function prepaidReport(): UsageReport {
	return {
		provider: "charm-hyper",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "charm-hyper:credits",
				label: "Credits",
				scope: { provider: "charm-hyper", shared: true },
				amount: { remaining: 100, unit: "credits" },
			},
		],
		metadata: { email: "pool@example.test" },
	};
}

function render(reports: UsageReport[], rows = 30, width = 100): string {
	const dashboard = new UsageDashboard({ reports, renderDetail: () => "DETAIL" });
	dashboard.setViewportRowsProvider(() => rows);
	return stripVTControlCharacters(dashboard.render(width).join("\n"));
}

describe("UsageDashboard", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("summarizes each provider's quota and balance in the default view", () => {
		const text = render([quotaReport(), prepaidReport()]);

		expect(text).toContain("openai-codex");
		expect(text).toContain("user@example.test");
		expect(text).toContain("75% free");
		expect(text).toContain("resets in");
		// A prepaid balance has no fraction to draw a bar from, so the summary
		// reports the amount in the value column instead of an empty cell.
		expect(text).toContain("100 credits left");
		expect(text).not.toContain("DETAIL");
	});

	it("adds a pool total when a provider mixes several meters", () => {
		const mixed: UsageReport = {
			...quotaReport(),
			limits: [
				...quotaReport().limits,
				{
					id: "codex-credits",
					label: "Credits",
					scope: { provider: "openai-codex", shared: true },
					amount: { remaining: 40, unit: "credits" },
				},
				{
					id: "codex-credits-2",
					label: "Credits (second key)",
					scope: { provider: "openai-codex", shared: true },
					amount: { remaining: 40, unit: "credits" },
				},
			],
		};

		const text = render([mixed]);

		// The same account-wide pool observed through two keys is one pool, so
		// the total counts it once even though a percentage window is mixed in.
		expect(text).toContain("prepaid: 40 credits left");
	});

	it("swaps the body for the full report and back", () => {
		const dashboard = new UsageDashboard({ reports: [quotaReport()], renderDetail: () => "DETAIL" });
		dashboard.setViewportRowsProvider(() => 30);

		dashboard.handleInput("\r");
		expect(stripVTControlCharacters(dashboard.render(100).join("\n"))).toContain("DETAIL");

		dashboard.handleInput("\r");
		expect(stripVTControlCharacters(dashboard.render(100).join("\n"))).not.toContain("DETAIL");
	});

	it("scrolls the detail view and closes on interrupt", () => {
		const dashboard = new UsageDashboard({
			reports: [quotaReport()],
			renderDetail: () => Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n"),
		});
		dashboard.setViewportRowsProvider(() => 10);
		let closed = false;
		dashboard.onClose = () => {
			closed = true;
		};
		dashboard.handleInput("\r");

		const first = stripVTControlCharacters(dashboard.render(100).join("\n"));
		expect(first).toContain("row 0");
		expect(first).not.toContain("row 20");

		dashboard.handleInput("\x1b[B");
		const scrolled = stripVTControlCharacters(dashboard.render(100).join("\n"));
		expect(scrolled).toContain("row 1");
		expect(scrolled).not.toContain("row 0");

		dashboard.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
