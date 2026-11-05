import "./happy-dom-shim";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { selectLaunchablePanelTabs, selectPanelTabComponent } from "../src/lib/slot-host";
import { apply } from "../src/plugins/session-info/index";
import SessionInfoPage from "../src/plugins/session-info/page";

interface ContextUsageResponse {
	tokens: number;
	contextWindow: number;
	percent: number;
	model?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
		cacheHitRate: number | null;
	};
}

type RpcRequest = (method: string, params?: unknown) => Promise<unknown>;

const previousLocale = getLocaleSnapshot();
const roots = new Set<Root>();

beforeAll(() => setLocale("zh-CN"));

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

afterAll(() => setLocale(previousLocale));

interface SessionRow {
	id: string;
	cwd?: string;
	model?: string;
	messageCount?: number;
}

function serve(options: {
	sessions: SessionRow[];
	usage?: ContextUsageResponse | null;
	approval?: string;
	directories?: Array<{ path: string; primary: boolean; exists: boolean }>;
}): {
	request: RpcRequest;
} {
	return {
		request: async method => {
			switch (method) {
				case "session.list":
					return options.sessions;
				case "session.contextUsage":
					return options.usage ?? null;
				case "settings.get":
					return { "tools.approvalMode": options.approval ?? "always-ask" };
				case "session.directories.list":
					return { directories: options.directories ?? [] };
				default:
					throw new Error(`unexpected RPC: ${method}`);
			}
		},
	};
}

async function mount(ui: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(ui));
	await act(async () => Bun.sleep(20));
	return { container, root };
}

function page(rpc: { request: RpcRequest }, sessionId: string | null, cwd?: string): React.ReactNode {
	return createElement(SessionInfoPage, { rpc: rpc as never, sessionId, cwd });
}

describe("session-info Cordis plugin", () => {
	it("registers a launchable right-panel tab that the panel resolver mounts", () => {
		const registrations: unknown[] = [];
		apply({
			setLabel() {},
			registerComponent(descriptor: unknown) {
				registrations.push(descriptor);
			},
		});
		expect(registrations).toEqual([
			{
				slot: "panel.tab.session-info",
				moduleUrl: "./page.tsx",
				label: "会话信息",
				availability: "always",
			},
		]);
		const item = {
			slot: "panel.tab.session-info",
			extensionId: "/plugins/session-info/index.ts",
			label: "会话信息",
			code: "export default function Page() { return null; }",
			availability: "always" as const,
		};
		// The rail lists only launchable panel tabs; the panel body resolves the
		// same registration through the `ext:` surface id.
		expect(selectLaunchablePanelTabs([item])).toEqual([item]);
		expect(selectPanelTabComponent([item], "ext:panel.tab.session-info")).toBe(item);
	});

	it("renders session metadata, the context window bar, and token totals", async () => {
		const { container } = await mount(
			page(
				serve({
					sessions: [{ id: "s1", cwd: "/work/project", model: "muse/deepseek-v4", messageCount: 42 }],
					usage: {
						tokens: 12_000,
						contextWindow: 200_000,
						percent: 6,
						model: "muse/deepseek-v4",
						usage: {
							input: 100,
							output: 50,
							cacheRead: 20,
							cacheWrite: 5,
							totalTokens: 175,
							cost: 0.042,
							cacheHitRate: 12.5,
						},
					},
					approval: "yolo",
				}),
				"s1",
				"/fallback",
			),
		);
		const text = container.textContent ?? "";
		expect(text).toContain(t("sessionInfo.title"));
		expect(text).toContain("s1");
		expect(text).toContain("/work/project");
		expect(text).toContain("muse/deepseek-v4");
		expect(text).toContain("42");
		expect(text).toContain(t("general.approvalModeYolo"));
		expect(text).toContain("12.5%");
		expect(text).toContain("$0.042");
		const bar = container.querySelector<HTMLElement>(".gui-ctx-usage-bar");
		expect(bar?.style.width).toBe("6%");
	});

	it("lists the session's additional working directories read-only", async () => {
		const { container } = await mount(
			page(
				serve({
					sessions: [{ id: "s1", cwd: "/work/primary", messageCount: 2 }],
					directories: [
						{ path: "/work/primary", primary: true, exists: true },
						{ path: "/work/shared", primary: false, exists: true },
						{ path: "/work/gone", primary: false, exists: false },
					],
				}),
				"s1",
			),
		);
		const text = container.textContent ?? "";
		expect(text).toContain(t("sessionInfo.additionalDirectories", { count: 2 }));
		// The primary directory already shows as the workspace row above.
		expect(text.match(/\/work\/primary/g)?.length).toBe(1);
		expect(text).toContain("/work/shared");
		expect(text).toContain(t("sessionInfo.directoryMissing"));
	});

	it("shows an empty additional-directory state when the session only has its primary root", async () => {
		const { container } = await mount(
			page(
				serve({
					sessions: [{ id: "s1", cwd: "/work/primary", messageCount: 1 }],
					directories: [{ path: "/work/primary", primary: true, exists: true }],
				}),
				"s1",
			),
		);
		expect(container.textContent).toContain(t("sessionInfo.noAdditionalDirectories"));
	});

	it("shows the empty state when the panel has no session", async () => {
		const { container } = await mount(page(serve({ sessions: [] }), null));
		expect(container.querySelector("[role=status]")?.textContent).toContain(t("sessionInfo.empty"));
	});

	it("keeps the previous session's usage out after a switch", async () => {
		const pending = Promise.withResolvers<ContextUsageResponse>();
		const rpc = {
			request: async (method: string, params?: unknown) => {
				switch (method) {
					case "session.list":
						return [{ id: "s2", cwd: "/work/two", messageCount: 7 }];
					case "session.contextUsage":
						return (params as { sessionId: string }).sessionId === "s1"
							? pending.promise
							: { tokens: 500, contextWindow: 1000, percent: 50, model: "muse/second" };
					default:
						return { "tools.approvalMode": "write" };
				}
			},
		};
		const first = await mount(page(rpc, "s1"));
		await act(async () => first.root.render(page(rpc, "s2")));
		await act(async () => Bun.sleep(20));
		expect(first.container.textContent).toContain("s2");
		expect(first.container.textContent).toContain("/work/two");
		expect(first.container.textContent).toContain("50%");
		await act(async () => {
			pending.resolve({ tokens: 999, contextWindow: 1000, percent: 99, model: "muse/stale" });
		});
		expect(first.container.textContent).not.toContain("muse/stale");
		expect(first.container.textContent).toContain("muse/second");
	});

	it("surfaces a failed metadata request and retries through the same effect", async () => {
		let fail = true;
		const rpc = {
			request: async (method: string) => {
				if (method === "session.list") {
					if (fail) throw new Error("daemon unavailable");
					return [{ id: "s1", cwd: "/work/retry", messageCount: 3 }];
				}
				if (method === "session.contextUsage") return null;
				return { "tools.approvalMode": "always-ask" };
			},
		};
		const { container } = await mount(page(rpc, "s1"));
		expect(container.querySelector("[role=alert]")?.textContent).toContain("daemon unavailable");
		fail = false;
		const retry = container.querySelector<HTMLButtonElement>("[role=alert] button");
		await act(async () => retry?.click());
		await act(async () => Bun.sleep(20));
		expect(container.querySelector("[role=alert]")).toBeNull();
		expect(container.textContent).toContain("/work/retry");
		expect(container.textContent).toContain("3");
	});

	it("copies the session id through the clipboard", async () => {
		const writes: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					writes.push(text);
				},
			},
		});
		const { container } = await mount(page(serve({ sessions: [{ id: "s1", messageCount: 1 }] }), "s1"));
		const copy = container.querySelector<HTMLButtonElement>(`button[aria-label="${t("transcript.copySessionId")}"]`);
		await act(async () => copy?.click());
		expect(writes).toEqual(["s1"]);
		expect(container.textContent).toContain(t("general.codeCopied"));
	});
});
