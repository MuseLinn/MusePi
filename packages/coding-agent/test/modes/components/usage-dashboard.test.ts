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

	it("reveals the full text of a truncated cell under the pointer", () => {
		const long: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "claude-7d",
					label: "Claude 7 Day Window With A Very Long Name",
					scope: { provider: "anthropic", windowId: "7d" },
					amount: { usedFraction: 0.5, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { email: "user@example.test" },
		};
		const dashboard = new UsageDashboard({ reports: [long], renderDetail: () => "DETAIL" });
		dashboard.setViewportRowsProvider(() => 30);
		const width = 60;
		// SGR rows are 1-based over the painted frame. Row 1 is the top border and
		// the body opens with a blank, the provider and the account, so the single
		// quota is painted on screen row 4.
		const quotaRow = 4;
		// Nothing is hovered yet: the key hint is what the reader sees.
		expect(stripVTControlCharacters(dashboard.render(width).join("\n"))).toContain("Enter details");

		// Pointer over the quota's title cell (BOX_INSET + LIMIT_INDENT columns).
		dashboard.handleInput(`\x1b[<35;${2 + 4 + 1};${quotaRow + 1}M`);
		const hovered = stripVTControlCharacters(dashboard.render(width).join("\n"));
		expect(hovered).toContain("Claude 7 Day Window With A Very Long Name");
		expect(hovered).not.toContain("Enter details");

		// Moving onto a row that hid nothing drops the hint again.
		dashboard.handleInput(`\x1b[<35;${2 + 4 + 1};1M`);
		expect(stripVTControlCharacters(dashboard.render(width).join("\n"))).toContain("Enter details");
	});

	it("leaves a cell that fits without a hint", () => {
		const dashboard = new UsageDashboard({ reports: [quotaReport()], renderDetail: () => "DETAIL" });
		dashboard.setViewportRowsProvider(() => 30);
		const wide = stripVTControlCharacters(dashboard.render(160).join("\n"));

		// "Weekly" fits at 160 columns, so hovering it must not replace the hint.
		dashboard.handleInput(`\x1b[<35;${2 + 4 + 1};4M`);
		expect(stripVTControlCharacters(dashboard.render(160).join("\n"))).toBe(wide);
		expect(wide).toContain("Enter details");
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
