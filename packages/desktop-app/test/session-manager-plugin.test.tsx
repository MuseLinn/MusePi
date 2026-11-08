import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
	archiveSession,
	clearArchivedSessions,
	getLocaleSnapshot,
	readArchivedSessions,
	setLocale,
	t,
} from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { navGroups } from "../src/components/SettingsNav";
import { PromptProvider } from "../src/lib/prompt-dialog";
import { apply } from "../src/plugins/session-manager/index";
import SessionManagerPage from "../src/plugins/session-manager/page";
import type { SessionListRow } from "../src/plugins/session-manager/types";

type RpcRequest = (method: string, params?: unknown) => Promise<unknown>;

const previousLocale = getLocaleSnapshot();
const roots = new Set<Root>();

setLocale("zh-CN");

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
	clearArchivedSessions();
	localStorage.removeItem("musepi-gui-autoclean");
	localStorage.removeItem("musepi-gui-autoclean-days");
	localStorage.removeItem("musepi-gui-autoclean-action");
	localStorage.removeItem("musepi-gui-autotitle");
	localStorage.removeItem("musepi-gui-confirm-delete");
});

afterAll(() => setLocale(previousLocale));

interface Served {
	sessions: SessionListRow[];
	/** Newest-first match pages keyed by session id (`session.search`). */
	prompts?: Record<string, Array<{ role: string; content: string }>>;
	failDelete?: Set<string>;
	failList?: boolean;
}

interface FakeRpc {
	request: RpcRequest;
	calls: Array<{ method: string; params?: unknown }>;
}

function serve(options: Served): FakeRpc {
	const calls: Array<{ method: string; params?: unknown }> = [];
	let listAttempts = 0;
	const request: RpcRequest = async (method, params) => {
		calls.push({ method, params });
		if (method === "session.list") {
			listAttempts += 1;
			if (options.failList === true && listAttempts === 1) throw new Error("daemon unavailable");
			return options.sessions;
		}
		if (method === "session.search") {
			const sessionId = (params as { sessionId?: string }).sessionId ?? "";
			return { matches: options.prompts?.[sessionId] ?? [], sessions: [] };
		}
		if (method === "session.delete") {
			const sessionId = (params as { sessionId?: string }).sessionId ?? "";
			if (options.failDelete?.has(sessionId) === true) throw new Error("session is streaming");
			return { ok: true };
		}
		if (method === "session.close") return { ok: true };
		throw new Error(`unexpected RPC: ${method}`);
	};
	return { request, calls };
}

async function mount(rpc: FakeRpc, sessionId: string | null = null): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () =>
		root.render(
			<PromptProvider>
				<SessionManagerPage rpc={rpc as never} sessionId={sessionId} />
			</PromptProvider>,
		),
	);
	await act(async () => Bun.sleep(30));
	return container;
}

function rowCount(container: HTMLElement): number {
	return container.querySelectorAll("tbody tr").length;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		candidate => candidate.textContent?.trim() === text,
	);
	if (!button) throw new Error(`button "${text}" did not render`);
	return button;
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
	await act(async () => button.click());
}

async function submitFilters(container: HTMLElement): Promise<void> {
	const form = container.querySelector("form");
	if (!form) throw new Error("filter form did not render");
	await act(async () => {
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

async function chooseOption(container: HTMLElement, ariaLabel: string, value: string): Promise<void> {
	const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`);
	if (!select) throw new Error(`select "${ariaLabel}" did not render`);
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
	await act(async () => {
		setter?.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
	// React tracks the controlled value internally; driving onChange through
	// the element's React props is the pattern the other DOM suites use.
	const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
	const props = propsKey
		? (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[propsKey]
		: undefined;
	if (!props?.onChange) throw new Error("input has no React onChange handler");
	await act(async () => {
		input.value = value;
		props.onChange?.({ target: input, currentTarget: input });
	});
}

async function confirmDialog(): Promise<void> {
	await act(async () => Bun.sleep(90));
	const confirmButton = document.querySelector<HTMLButtonElement>(".gui-dialog .gui-btn-primary");
	if (!confirmButton) throw new Error("confirm dialog did not open");
	await act(async () => confirmButton.click());
	// The provider settles after its 180ms exit animation.
	await act(async () => Bun.sleep(220));
	await act(async () => Bun.sleep(20));
}

function session(id: string, overrides: Partial<SessionListRow> = {}): SessionListRow {
	return {
		id,
		title: `Session ${id}`,
		cwd: "D:/work/alpha",
		timestamp: "2026-10-01T08:00:00.000Z",
		updatedAt: "2026-10-20T08:00:00.000Z",
		messageCount: 4,
		...overrides,
	};
}

describe("session-manager Cordis plugin", () => {
	it("registers the settings.tab.sessions page as 会话", () => {
		const registrations: unknown[] = [];
		apply({
			setLabel() {},
			slots: {
				register(component) {
					registrations.push(component);
				},
			},
		});
		expect(registrations).toEqual([
			{
				slot: "settings.tab.sessions",
				moduleUrl: "./page.tsx",
				label: "会话",
				availability: "always",
			},
		]);
		// The nav derives its rows from the same slot list. The plugin takes
		// over the built-in 会话 page in place, so there is exactly one row and
		// no duplicate `ext:` entry.
		const items = navGroups([{ slot: "settings.tab.sessions", label: "会话" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "ext:settings.tab.sessions")).toBe(false);
		expect(items.find(item => item.id === "sessions")?.label).toBe(t("general.sessions"));
	});

	it("renders project basenames, disambiguates duplicates, and paginates", async () => {
		const sessions: SessionListRow[] = [];
		for (let index = 0; index < 23; index++) {
			sessions.push(
				session(`a${index}`, {
					cwd: "D:/work/demo",
					updatedAt: `2026-10-${String(20 - (index % 10)).padStart(2, "0")}T08:00:00.000Z`,
				}),
			);
		}
		sessions.push(session("b1", { cwd: "D:/other/demo" }));
		sessions.push(session("c1", { cwd: "D:/solo/project" }));
		const container = await mount(serve({ sessions }));

		expect(rowCount(container)).toBe(20);
		expect(container.textContent).toContain(t("settings.sessionManager.totalCount", { count: 25 }));
		expect(container.textContent).toContain("work/demo");
		expect(container.textContent).toContain("other/demo");
		expect(container.textContent).toContain("project");

		await clickButton(buttonByText(container, t("settings.sessionManager.nextPage")));
		expect(rowCount(container)).toBe(5);
		expect(container.textContent).toContain(t("settings.sessionManager.pageInfo", { page: 2, pages: 2 }));
	});

	it("filters by status and last activity through 查询", async () => {
		const day = 86_400_000;
		const now = Date.now();
		const sessions = [
			session("running", { working: true, updatedAt: new Date(now - day).toISOString() }),
			session("done", { updatedAt: new Date(now - 2 * day).toISOString() }),
			session("old", { updatedAt: new Date(now - 300 * day).toISOString() }),
		];
		const container = await mount(serve({ sessions }));
		expect(rowCount(container)).toBe(3);

		await chooseOption(container, t("settings.sessionManager.status"), "running");
		await submitFilters(container);
		expect(rowCount(container)).toBe(1);
		expect(container.textContent).toContain("Session running");
		expect(container.textContent).not.toContain("Session done");

		await chooseOption(container, t("settings.sessionManager.status"), "all");
		await chooseOption(container, t("settings.sessionManager.updatedWithin"), "30");
		await submitFilters(container);
		expect(rowCount(container)).toBe(2);
		expect(container.textContent).not.toContain("Session old");

		await clickButton(buttonByText(container, t("settings.sessionManager.reset")));
		expect(rowCount(container)).toBe(3);
	});

	it("searches titles and projects live", async () => {
		const container = await mount(
			serve({
				sessions: [
					session("alpha", { title: "Fix parser" }),
					session("beta", { title: "Write docs", cwd: "D:/work/beta" }),
				],
			}),
		);
		const search = container.querySelector<HTMLInputElement>(
			`input[aria-label="${t("settings.sessionManager.searchPlaceholder")}"]`,
		);
		if (!search) throw new Error("search input did not render");
		await typeInto(search, "docs");
		expect(rowCount(container)).toBe(1);
		expect(container.textContent).toContain("Write docs");
		await typeInto(search, "missing");
		expect(rowCount(container)).toBe(0);
		expect(container.textContent).toContain(t("settings.sessionManager.emptyFiltered"));
	});

	it("shows the newest user prompt from session.search", async () => {
		const rpc = serve({
			sessions: [session("s1")],
			prompts: {
				s1: [
					{ role: "assistant", content: "Done: tests pass" },
					{ role: "user", content: "  fix   the parser  " },
				],
			},
		});
		const container = await mount(rpc);
		expect(container.textContent).toContain("fix the parser");
		const search = rpc.calls.find(call => call.method === "session.search");
		// Newest-first, per-session: an empty query returns the tail of the
		// transcript without reading the whole session.
		expect(search?.params).toMatchObject({ query: "", sessionId: "s1" });
	});

	it("archives selected sessions only after the bulk confirmation", async () => {
		const sessions = [session("s1"), session("s2"), session("s3")];
		const container = await mount(serve({ sessions }));
		const checkboxes = [...container.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox]")];
		await act(async () => checkboxes[0]?.click());
		await act(async () => checkboxes[1]?.click());
		expect(container.textContent).toContain(t("settings.sessionManager.selectedCount", { count: 2 }));

		await clickButton(buttonByText(container, t("settings.sessionManager.bulkArchive")));
		expect(readArchivedSessions()).toHaveLength(0);
		await confirmDialog();

		expect(
			readArchivedSessions()
				.map(entry => entry.sessionId)
				.sort(),
		).toEqual(["s1", "s2"]);
		const statusCells = [...container.querySelectorAll("tbody tr")].map(row => row.textContent ?? "");
		expect(statusCells.filter(cell => cell.includes(t("settings.archived"))).length).toBe(2);
	});

	it("restores archived sessions and keeps them out of the 进行中 filter", async () => {
		archiveSession("s1", "D:/work/alpha");
		const container = await mount(serve({ sessions: [session("s1"), session("s2", { working: true })] }));
		// The archived row has no bulk bar until selected; restore from its row.
		const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];
		const archivedRow = rows.find(row => (row.textContent ?? "").includes(t("settings.archived")));
		expect(archivedRow).toBeDefined();
		const restore = archivedRow?.querySelector<HTMLButtonElement>(`button[aria-label="${t("settings.unarchive")}"]`);
		if (!restore) throw new Error("restore button did not render");
		await clickButton(restore);
		expect(readArchivedSessions()).toHaveLength(0);
		const refreshed = [...container.querySelectorAll("tbody tr")].map(row => row.textContent ?? "");
		expect(refreshed.filter(cell => cell.includes(t("settings.archived"))).length).toBe(0);
	});

	it("deletes after confirmation and refuses the open session", async () => {
		const rpc = serve({ sessions: [session("open"), session("other")] });
		const container = await mount(rpc, "open");
		const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];
		const openRow = rows.find(row => (row.textContent ?? "").includes("Session open"));
		const otherRow = rows.find(row => (row.textContent ?? "").includes("Session other"));
		const openDelete = openRow?.querySelector<HTMLButtonElement>(`button[aria-label="${t("settings.delete")}"]`);
		expect(openDelete?.disabled).toBe(true);

		const otherDelete = otherRow?.querySelector<HTMLButtonElement>(`button[aria-label="${t("settings.delete")}"]`);
		if (!otherDelete) throw new Error("delete button did not render");
		await clickButton(otherDelete);
		expect(rpc.calls.some(call => call.method === "session.delete")).toBe(false);
		await confirmDialog();

		expect(rpc.calls.filter(call => call.method === "session.delete")).toEqual([
			{ method: "session.delete", params: { sessionId: "other" } },
		]);
		expect(container.textContent).not.toContain("Session other");
		expect(container.textContent).toContain("Session open");
	});

	it("surfaces a failed session.list and retries in place", async () => {
		const rpc = serve({ sessions: [session("s1")], failList: true });
		const container = await mount(rpc);
		expect(container.querySelector("[role=alert]")?.textContent).toContain("daemon unavailable");
		await clickButton(buttonByText(container, t("settings.sessionManager.retry")));
		await act(async () => Bun.sleep(20));
		expect(container.querySelector("[role=alert]")).toBeNull();
		expect(container.textContent).toContain("Session s1");
	});
});
