import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScheduledTasksPage } from "../src/components/ScheduledTasksPage";
import { TaskCalendarView } from "../src/components/TaskCenterViews";

const today = new Date();
const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

function task(id: string, name: string) {
	return {
		id,
		name,
		enabled: true,
		schedule: { kind: "once" as const, date: iso, time: "09:00" },
		prompt: `Prompt ${id}`,
		cwd: "/repo",
		state: { createdAt: Date.now(), nextRunAt: today.getTime() + 60_000 },
	};
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(element: ReturnType<typeof createElement>): void {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root!.render(element));
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	host?.remove();
	host = null;
	root = null;
});

describe("task-center selection", () => {
	test("a calendar day exposes every task as an actionable item", async () => {
		const selected: string[] = [];
		mount(
			createElement(TaskCalendarView, {
				tasks: [task("a", "Alpha"), task("b", "Beta")],
				runs: [],
				onSelectTask: (id: string) => selected.push(id),
			}),
		);
		await act(async () => host!.querySelector<HTMLButtonElement>(".gui-taskcal-cell--today")?.click());
		const items = host!.querySelectorAll<HTMLButtonElement>(".gui-taskcal-day-task");
		expect(items.length).toBe(2);
		items[0]?.click();
		items[1]?.click();
		expect(selected).toEqual(["a", "b"]);
	});

	test("choosing a calendar task opens its visible detail", async () => {
		const rpc = {
			request: (method: string) => {
				if (method === "cron.list")
					return Promise.resolve({ tasks: [task("a", "Alpha"), task("b", "Beta")], runs: [] });
				if (method === "cron.runs") return Promise.resolve({ runs: [] });
				return Promise.resolve({});
			},
		};
		mount(createElement(ScheduledTasksPage, { rpc, onBack: () => {} }));
		await act(async () => Bun.sleep(0));
		const tabs = host!.querySelectorAll<HTMLButtonElement>(".gui-taskcenter-tab");
		await act(async () => tabs[0]?.click());
		await act(async () => host!.querySelector<HTMLButtonElement>(".gui-taskcal-cell--today")?.click());
		const item = host!.querySelector<HTMLButtonElement>(".gui-taskcal-day-task");
		expect(item?.textContent).toContain("Alpha");
		await act(async () => item?.click());
		expect(host!.querySelector(".gui-scheduled-detail-title")?.textContent).toBe("Alpha");
	});
});
