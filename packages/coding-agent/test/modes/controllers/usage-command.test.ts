import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { UsageReport } from "@musepi/pi-ai";
import { UsageDashboard } from "@musepi/pi-coding-agent/modes/components/usage-dashboard";
import { CommandController, renderUsageReports } from "@musepi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@musepi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";

/**
 * `/usage` opens the fullscreen dashboard, whose expanded view is the classic
 * report. These tests pin that report's text, so they render the dashboard's
 * detail view (Enter) rather than the retired inline panel. The viewport is
 * wide so the report's own column fitting is not what is under test.
 */
function renderDashboardDetail(reports: UsageReport[], width = 200): string {
	const dashboard = new UsageDashboard({
		reports,
		renderDetail: (renderWidth, detailReports) => renderUsageReports(detailReports, theme, Date.now(), renderWidth),
	});
	dashboard.setViewportRowsProvider(() => 40);
	dashboard.handleInput("\r");
	return dashboard.render(width).join("\n");
}

function createUsageSessionDouble() {
	return { getUsageReportingModelSelectors: () => [] };
}

/**
 * Context double for `/usage`. The command's product is the dashboard, so the
 * double records what the dashboard would be shown rather than rendered output.
 */
function createUsageContext(): { ctx: InteractiveModeContext; dashboardReports: UsageReport[][] } {
	const dashboardReports: UsageReport[][] = [];
	const ctx = {
		session: createUsageSessionDouble(),
		ui: { terminal: { columns: 100 } },
		present: vi.fn(),
		presentCommandOutput: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showUsageDashboard: (reports: UsageReport[]) => {
			dashboardReports.push(reports);
		},
	} as unknown as InteractiveModeContext;
	return { ctx, dashboardReports };
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const { ctx, dashboardReports } = createUsageContext();
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(dashboardReports).toHaveLength(1);
		const output = renderDashboardDetail(dashboardReports[0]!);
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const { ctx, dashboardReports } = createUsageContext();
		const controller = new CommandController(ctx);
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(dashboardReports).toHaveLength(1);
		const output = renderDashboardDetail(dashboardReports[0]!);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const { ctx, dashboardReports } = createUsageContext();
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		await controller.handleUsageCommand(reports);

		expect(dashboardReports).toHaveLength(1);
		const output = renderDashboardDetail(dashboardReports[0]!);
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});
});
