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
import type { SessionListRow, SessionMessage } from "../src/plugins/session-manager/types";

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
	/** `session.lastPrompts` response (newest user message per session). */
	prompts?: Record<string, string>;
	/** Cross-session `session.search` matches. */
	matches?: SessionMessage[];
	/** `history.messages` rows per session. */
	transcripts?: Record<string, SessionMessage[]>;
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
		if (method === "session.lastPrompts") {
			return options.prompts ?? {};
		}
		if (method === "session.search") {
			const query = (params as { query?: string }).query ?? "";
			return {
				matches: (options.matches ?? []).filter(
					match => match.content.toLowerCase().includes(query.toLowerCase()) || query === "",
				),
				sessions: [],
			};
		}
		if (method === "history.messages") {
			const sessionId = (params as { sessionId?: string }).sessionId ?? "";
			return options.transcripts?.[sessionId] ?? [];
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

async function mount(
	rpc: FakeRpc,
	sessionId: string | null = null,
	onOpenSession?: (id: string) => void,
): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () =>
		root.render(
			<PromptProvider>
				<SessionManagerPage rpc={rpc as never} sessionId={sessionId} onOpenSession={onOpenSession} />
			</PromptProvider>,
		),
	);
	await act(async () => Bun.sleep(40));
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

function searchInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>(
		`input[aria-label="${t("settings.sessionManager.searchPlaceholder")}"]`,
	);
	if (!input) throw new Error("search input did not render");
	return input;
}

function sessionNameButton(container: HTMLElement, title: string): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(
		`button[title="${t("settings.sessionManager.expandRow", { title })}"]`,
	);
	if (!button) throw new Error(`session row "${title}" did not render`);
	return button;
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

function message(
	sessionId: string,
	seq: number,
	role: string,
	content: string,
	timestamp = Date.UTC(2026, 9, 20, 8, 0, seq),
): SessionMessage {
	return { sessionId, seq, role, model: null, content, timestamp };
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
		// The retired 历史会话 page is gone from the 数据与统计 group: message
		// browsing lives on the session page now.
		expect(items.some(item => item.id === "history")).toBe(false);
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

	it("filters by status and last activity as soon as a filter changes", async () => {
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
		expect(rowCount(container)).toBe(1);
		expect(container.textContent).toContain("Session running");
		expect(container.textContent).not.toContain("Session done");

		await chooseOption(container, t("settings.sessionManager.status"), "all");
		await chooseOption(container, t("settings.sessionManager.updatedWithin"), "30");
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
		await typeInto(searchInput(container), "docs");
		expect(rowCount(container)).toBe(1);
		expect(container.textContent).toContain("Write docs");
		await typeInto(searchInput(container), "missing");
		expect(rowCount(container)).toBe(0);
		expect(container.textContent).toContain(t("settings.sessionManager.emptyFiltered"));
		// The empty state is actionable: one click restores the list.
		await clickButton(buttonByText(container, t("settings.sessionManager.reset")));
		expect(rowCount(container)).toBe(2);
	});

	it("shows the transcript verdict instead of a blanket 已完成", async () => {
		const container = await mount(
			serve({ sessions: [session("cut", { status: "interrupted" }), session("fine", { status: "complete" })] }),
		);
		const rows = [...container.querySelectorAll("tbody tr")].map(row => row.textContent ?? "");
		expect(rows.some(cell => cell.includes(t("session status interrupted")))).toBe(true);
		expect(rows.some(cell => cell.includes(t("session status complete")))).toBe(true);
	});

	it("reads one page of last prompts with one batched RPC", async () => {
		const rpc = serve({
			sessions: [session("s1"), session("s2")],
			prompts: {
				s1: "fix   the parser",
				s2: JSON.stringify([{ type: "text", text: "write docs" }]),
			},
		});
		const container = await mount(rpc);
		expect(container.textContent).toContain("fix the parser");
		expect(container.textContent).toContain("write docs");
		const batched = rpc.calls.filter(call => call.method === "session.lastPrompts");
		expect(batched).toHaveLength(1);
		expect(batched[0]?.params).toEqual({ sessionIds: ["s1", "s2"] });
		// The old path scanned each transcript tail through session.search;
		// nothing on this page should need it.
		expect(rpc.calls.some(call => call.method === "session.search")).toBe(false);
	});

	it("finds sessions by message content and expands only the hits", async () => {
		const rpc = serve({
			sessions: [session("alpha", { title: "Fix parser" }), session("beta", { title: "Write docs" })],
			matches: [message("beta", 7, "user", "the login flow is broken")],
			transcripts: {
				beta: [message("beta", 1, "user", "start here"), message("beta", 7, "user", "the login flow is broken")],
			},
		});
		const container = await mount(rpc);
		await typeInto(searchInput(container), "login");
		await act(async () => Bun.sleep(400));

		// The title does not contain the term; the message does.
		expect(rowCount(container)).toBe(1);
		expect(container.textContent).toContain("Write docs");
		expect(container.textContent).toContain(t("settings.sessionManager.messageHits", { count: 1 }));

		await clickButton(sessionNameButton(container, "Write docs"));
		await act(async () => Bun.sleep(20));
		expect(container.textContent).toContain("the login flow is broken");
		// Hits are already in hand — the transcript is not read for them.
		expect(rpc.calls.some(call => call.method === "history.messages")).toBe(false);

		await clickButton(buttonByText(container, t("settings.sessionManager.allMessages")));
		await act(async () => Bun.sleep(20));
		expect(rpc.calls.find(call => call.method === "history.messages")?.params).toEqual({
			sessionId: "beta",
			limit: 200,
			tail: true,
		});
		expect(container.textContent).toContain("start here");
	});

	it("expands a row into its transcript and can open the session", async () => {
		let opened: string | null = null;
		const rpc = serve({
			sessions: [session("s1", { title: "Fix parser" })],
			transcripts: { s1: [message("s1", 1, "user", "hello there"), message("s1", 2, "assistant", "on it")] },
		});
		const container = await mount(rpc, null, id => {
			opened = id;
		});
		await clickButton(sessionNameButton(container, "Fix parser"));
		await act(async () => Bun.sleep(20));

		expect(rpc.calls.find(call => call.method === "history.messages")?.params).toEqual({
			sessionId: "s1",
			limit: 200,
			tail: true,
		});
		expect(container.textContent).toContain("hello there");
		expect(container.textContent).toContain("on it");

		await clickButton(buttonByText(container, t("settings.sessionManager.openSession")));
		expect(opened as string | null).toBe("s1");

		// Collapsing closes the detail row.
		await clickButton(sessionNameButton(container, "Fix parser"));
		expect(container.textContent).not.toContain("hello there");
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
