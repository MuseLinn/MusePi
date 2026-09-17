/**
 * schedule_task renderer tests (issue #11): the agent created or listed a
 * scheduled task in the conversation, and the card must show a structured
 * summary (name, schedule, next run, 闲时窗口) with a jump into the task
 * center — not a raw JSON row. Both props may be partial: `args` arrive while
 * the call streams and `details` is the daemon's answer.
 */
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../src/i18n/index.js";
import { resolveToolRenderer } from "../src/tool-render/registry";
import { scheduleTaskRenderer } from "../src/tool-render/tools/schedule-task";
import type { ToolRenderProps } from "../src/tool-render/types";

const Body = scheduleTaskRenderer.Body as (props: ToolRenderProps) => ReactNode;
const Summary = scheduleTaskRenderer.Summary as (props: ToolRenderProps) => string;

const ARGS = {
	action: "create",
	name: "nightly tests",
	prompt: "run the test suite",
	schedule: { kind: "daily", time: "22:00", idleWindow: { start: "23:00", end: "08:00" } },
};

const DETAILS = {
	taskId: "cron-abc",
	scheduleSummary: "daily at 22:00 · idle window 23:00–08:00",
	nextRunAt: Date.UTC(2026, 8, 17, 14, 0, 0),
};

describe("schedule_task renderer", () => {
	it("is registered for the wire tool name", () => {
		expect(resolveToolRenderer("schedule_task")).toBe(scheduleTaskRenderer);
	});

	it("renders name, schedule summary and next run", () => {
		const html = renderToStaticMarkup(Body({ args: ARGS, result: { content: [], details: DETAILS } } as never));
		expect(html).toContain("nightly tests");
		expect(html).toContain("daily at 22:00");
		expect(html).toContain("tv-board-open");
	});

	it("marks the idle window (闲时任务)", () => {
		const html = renderToStaticMarkup(Body({ args: ARGS, result: { content: [], details: DETAILS } } as never));
		expect(html).toContain("23:00");
		expect(html).toContain("08:00");
	});

	it("still renders a card while the call is streaming (args only, no details yet)", () => {
		const html = renderToStaticMarkup(Body({ args: ARGS, result: undefined } as never));
		expect(html).toContain("nightly tests");
		// No id yet → no jump button, but the card is still a card.
		expect(html).not.toContain("tv-board-open");
	});

	it("falls back to the args idle window when details lack one", () => {
		const html = renderToStaticMarkup(
			Body({
				args: ARGS,
				result: { content: [], details: { taskId: "cron-abc", scheduleSummary: "daily at 22:00" } },
			} as never),
		);
		expect(html).toContain("23:00");
	});

	it("lists tasks for action=list", () => {
		const html = renderToStaticMarkup(
			Body({
				args: { action: "list" },
				result: {
					content: [],
					details: { action: "list", tasks: [{ id: "cron-1", name: "weekly scan", summary: "weekly on 周五" }] },
				},
			} as never),
		);
		expect(html).toContain("weekly scan");
		expect(html).toContain("周五");
	});

	it("says 暂无定时任务 when the list is empty", () => {
		const html = renderToStaticMarkup(
			Body({ args: { action: "list" }, result: { content: [], details: { action: "list", tasks: [] } } } as never),
		);
		expect(html).toContain(t("no scheduled tasks"));
	});

	it("tolerates malformed details instead of throwing", () => {
		const html = renderToStaticMarkup(Body({ args: null, result: { content: [], details: 42 } } as never));
		expect(typeof html).toBe("string");
	});

	it("summarises into one line", () => {
		expect(Summary({ args: ARGS, result: undefined } as never)).toContain("nightly tests");
		expect(Summary({ args: { action: "list" }, result: undefined } as never)).toContain(t("scheduled task"));
	});
});
