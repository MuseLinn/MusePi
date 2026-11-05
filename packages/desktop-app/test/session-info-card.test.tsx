import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setLocale, t } from "@musepi/client-core";
import type { SessionEntry, SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { CONNECTOR_STATUS_KEY } from "../src/components/composer/connector-panel";
import {
	SESSION_INFO_DOCK_WIDTH_PX,
	SessionInfoCard,
	useSessionInfoCardVisibility,
} from "../src/components/session-info-card";
import type { PanelTab } from "../src/lib/panel-tabs";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";
import { SURFACE_HIDDEN_KEY } from "../src/lib/surfaces/registry";

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

interface RpcCall {
	method: string;
	params?: unknown;
}

type Handler = (params: Record<string, unknown>) => unknown;

/** Fake daemon: unknown methods answer `{}` (arrays for model lists) so
 *  ChatView's boot effects settle instead of crashing a selector. */
function makeRpc(handlers: Partial<Record<string, Handler>> = {}, calls: RpcCall[] = []): RpcClient {
	return {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			const handler = handlers[method];
			if (handler) return handler((params ?? {}) as Record<string, unknown>);
			return method.startsWith("models.list") ? [] : {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

function tab(index: number, surface = "files"): PanelTab {
	const label = `file-${index}.ts`;
	return {
		id: `${surface}::${label}`,
		surface,
		target: label,
		label,
		readOnly: false,
		touchedAt: index,
		dedupeKey: null,
		dirty: false,
		preview: false,
		column: 0,
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

interface Mounted {
	host: HTMLElement;
	rerender(node: ReactNode): Promise<void>;
	unmount(): Promise<void>;
}

async function mount(node: ReactNode): Promise<Mounted> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(node);
	});
	// Superseded `act` batches: the data effects resolve on later microtasks.
	await flush();
	return {
		host,
		rerender: async (next: ReactNode) => {
			await act(async () => root.render(next));
			await flush();
		},
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const CARD_PROPS = {
	sessionId: "session-1",
	cwd: "C:/workspace",
	title: "修复会话信息卡",
	tabs: [] as PanelTab[],
	activeTabId: null,
	top: 54,
};

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.head.querySelectorAll("style").forEach(node => node.remove());
});

describe("SessionInfoCard 数据契约", () => {
	it("汇总 git.numstat 的 +/− 并显示会话模型 provider/id", async () => {
		const rpc = makeRpc({
			"session.contextUsage": () => ({ tokens: 1, contextWindow: 10, percent: 10, model: "anthropic/claude-x" }),
			"git.numstat": () => ({
				files: [
					{ path: "a.ts", added: 3, removed: 1, binary: false },
					{ path: "b.ts", added: 2, removed: 4, binary: false },
				],
			}),
		});
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		expect(host.querySelector(".gui-session-info-model-value")?.textContent).toBe("anthropic/claude-x");
		expect(host.querySelector(".gui-session-info-title")?.textContent).toBe(CARD_PROPS.title);
		const changes = host.querySelector(".gui-session-info-changes")!;
		expect(changes.getAttribute("data-state")).toBe("ready");
		expect(changes.textContent).toContain("+5");
		expect(changes.textContent).toContain("−5");
		await unmount();
	});

	it("非 git 目录降级为无变更而不是错误", async () => {
		const rpc = makeRpc({
			"session.contextUsage": () => ({ model: "openai/gpt" }),
			"git.numstat": () => ({ error: "not a git repository" }),
		});
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		const changes = host.querySelector(".gui-session-info-changes")!;
		expect(changes.getAttribute("data-state")).toBe("none");
		expect(changes.textContent).toContain(t("general.sessionInfoNoChanges"));
		expect(changes.textContent).not.toContain("not a git repository");
		await unmount();
	});

	it("git.numstat 拒绝时给出错误态，重试重新请求", async () => {
		const calls: RpcCall[] = [];
		let attempts = 0;
		const rpc = makeRpc(
			{
				"session.contextUsage": () => ({ model: "openai/gpt" }),
				"git.numstat": () => {
					attempts += 1;
					if (attempts === 1) throw new Error("daemon offline");
					return { files: [{ path: "a.ts", added: 1, removed: 0, binary: false }] };
				},
			},
			calls,
		);
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		const changes = host.querySelector(".gui-session-info-changes")!;
		expect(changes.getAttribute("data-state")).toBe("error");
		expect(changes.textContent).toContain("daemon offline");
		await act(async () => {
			changes.querySelector<HTMLButtonElement>(".gui-session-info-retry")!.click();
		});
		await flush();
		expect(calls.filter(call => call.method === "git.numstat")).toHaveLength(2);
		expect(host.querySelector(".gui-session-info-changes")?.getAttribute("data-state")).toBe("ready");
		await unmount();
	});

	it("请求未返回时显示加载态", async () => {
		const rpc = makeRpc({
			"session.contextUsage": () => new Promise(() => {}),
			"git.numstat": () => new Promise(() => {}),
		});
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		expect(host.querySelector(".gui-session-info-changes")?.getAttribute("data-state")).toBe("loading");
		expect(host.querySelector(".gui-session-info-model")?.getAttribute("data-state")).toBe("loading");
		await unmount();
	});
});

describe("SessionInfoCard 标签与可打开表面", () => {
	it("超过 6 条标签折叠为查看更多，点击后全部展开并切到该标签", async () => {
		const tabs = Array.from({ length: 8 }, (_, index) => tab(index));
		const opened: string[] = [];
		const { host, unmount } = await mount(
			<SessionInfoCard
				{...CARD_PROPS}
				rpc={makeRpc()}
				tabs={tabs}
				activeTabId={tabs[1]!.id}
				onSelectTab={id => opened.push(id)}
			/>,
		);
		expect(host.querySelectorAll(".gui-session-info-item")).toHaveLength(6);
		const more = host.querySelector<HTMLButtonElement>(".gui-session-info-tabs .gui-session-info-more")!;
		expect(more.textContent).toContain(t("general.sessionInfoMore", { count: 2 }));
		await act(async () => more.click());
		expect(host.querySelectorAll(".gui-session-info-item")).toHaveLength(8);
		expect(host.querySelector(".gui-session-info-tabs .gui-session-info-more")).toBeNull();
		expect(host.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
		await act(async () => {
			host.querySelectorAll<HTMLButtonElement>(".gui-session-info-item")[3]!.click();
		});
		expect(opened).toEqual([tabs[3]!.id]);
		await unmount();
	});

	it("无打开标签时给出空态，并列出可用表面（尊重 rail 隐藏）", async () => {
		localStorage.setItem(SURFACE_HIDDEN_KEY, JSON.stringify(["git"]));
		const opened: string[] = [];
		const { host, unmount } = await mount(
			<SessionInfoCard {...CARD_PROPS} rpc={makeRpc()} onOpenSurface={id => opened.push(id)} />,
		);
		expect(host.querySelector(".gui-session-info-tabs-empty")?.textContent).toContain(t("general.sessionInfoNoTabs"));
		const labels = [...host.querySelectorAll(".gui-session-info-surface")].map(node => node.textContent);
		expect(labels).toContain(t("files"));
		expect(labels).not.toContain(t("git"));
		await act(async () => {
			host.querySelectorAll<HTMLButtonElement>(".gui-session-info-surface")[0]!.click();
		});
		expect(opened).toHaveLength(1);
		await unmount();
	});
});

describe("SessionInfoCard 连接器与插件", () => {
	it("连接器 section 列出服务器与状态，取消勾选写回窄化选择", async () => {
		let selected: string[] | null = null;
		const calls: RpcCall[] = [];
		const servers = [
			{ name: "fs", transport: "stdio", status: "connected" },
			{ name: "web", transport: "http", status: "disconnected" },
		];
		const rpc = makeRpc(
			{
				"connectors.list": () => ({ servers, selected }),
				"connectors.setSelected": params => {
					selected = (params.servers as string[] | null) ?? null;
					return { ok: true, appliedToLive: true };
				},
			},
			calls,
		);
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		const rows = [...host.querySelectorAll(".gui-session-info-connectors .gui-connector-row")];
		expect(rows).toHaveLength(2);
		expect(rows.map(row => row.querySelector(".gui-connector-row-name")?.textContent)).toEqual(["fs", "web"]);
		expect(host.querySelector(".gui-connector-dot--connected")).not.toBeNull();
		expect(host.querySelector(".gui-connector-dot--disconnected")).not.toBeNull();
		// The dot's tooltip names the real health, not the configured state.
		expect(host.querySelector(".gui-connector-dot--connected")?.getAttribute("title")).toBe(
			t(CONNECTOR_STATUS_KEY.connected),
		);
		expect(host.querySelector(".gui-connector-dot--disconnected")?.getAttribute("title")).toBe(
			t(CONNECTOR_STATUS_KEY.disconnected),
		);
		const boxes = [...host.querySelectorAll<HTMLInputElement>(".gui-session-info-connectors input[type='checkbox']")];
		expect(boxes.map(box => box.checked)).toEqual([true, true]);

		await act(async () => boxes[0]!.click());
		await flush();
		const write = calls.find(call => call.method === "connectors.setSelected");
		expect(write?.params).toEqual({ sessionId: "session-1", servers: ["web"] });
		const after = [...host.querySelectorAll<HTMLInputElement>(".gui-session-info-connectors input[type='checkbox']")];
		expect(after.map(box => box.checked)).toEqual([false, true]);
		await unmount();
	});

	it("插件 section 显示运行数，展开后列出运行/禁用状态", async () => {
		const rpc = makeRpc({
			"extensions.list": () => ({
				extensions: [
					{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "active" },
					{ id: "beta", kind: "plugin-module", name: "beta", displayName: "", state: "disabled" },
					{ id: "gamma", kind: "extension-module", name: "gamma", displayName: "", state: "active" },
					{ id: "theme", kind: "theme-pack", name: "theme", displayName: "", state: "active" },
				],
			}),
		});
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		const head = host.querySelector<HTMLButtonElement>(".gui-session-info-plugins-head")!;
		expect(head.textContent).toContain(t("general.sessionInfoPlugins"));
		// Two of the three plugin entries are active; the theme pack is not a plugin.
		expect(head.textContent).toContain("2/3");
		expect(head.getAttribute("aria-expanded")).toBe("false");
		const body = host.querySelector<HTMLElement>(".gui-session-info-plugins .gui-collapse")!;
		expect(body.getAttribute("aria-hidden")).toBe("true");

		await act(async () => head.click());
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(body.getAttribute("aria-hidden")).toBe("false");
		const rows = [...host.querySelectorAll(".gui-session-info-plugin")].map(node => node.textContent);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("Alpha");
		expect(rows[0]).toContain(t("settings.extensionsStateRunning"));
		await unmount();
	});

	it("插件状态条位于分区上方，点开列出运行/禁用明细", async () => {
		const rpc = makeRpc({
			"extensions.list": () => ({
				extensions: [
					{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "active" },
					{ id: "beta", kind: "plugin-module", name: "beta", displayName: "", state: "disabled" },
					{ id: "gamma", kind: "extension-module", name: "gamma", displayName: "", state: "active" },
					{ id: "theme", kind: "theme-pack", name: "theme", displayName: "", state: "active" },
				],
			}),
		});
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		const strip = host.querySelector<HTMLButtonElement>(".gui-session-info-plugin-status")!;
		expect(strip).not.toBeNull();
		expect(strip.textContent).toContain(t("settings.extensionsRunning", { count: "2" }));
		expect(strip.getAttribute("aria-expanded")).toBe("false");
		// The readout sits above the section's own count + roster.
		const head = host.querySelector<HTMLElement>(".gui-session-info-plugins-head")!;
		expect(strip.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

		await act(async () => strip.click());
		expect(strip.getAttribute("aria-expanded")).toBe("true");
		const menu = document.querySelector<HTMLElement>(".gui-ext-status-menu")!;
		expect(menu).not.toBeNull();
		// Portaled out of the card's scrolling box, so the roster cannot be clipped.
		expect(host.contains(menu)).toBe(false);
		const rows = [...menu.querySelectorAll(".gui-ext-status-row")].map(node => node.textContent);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("Alpha");
		expect(rows[0]).toContain(t("settings.extensionsStateRunning"));
		expect(rows[1]).toContain("beta");
		expect(rows[1]).toContain(t("settings.extensionsStateDisabled"));
		await unmount();
	});

	it("全部插件停用时状态条消失，分区仍保留禁用读数", async () => {
		const rpc = makeRpc({
			"extensions.list": () => ({
				extensions: [{ id: "beta", kind: "plugin-module", name: "beta", displayName: "", state: "disabled" }],
			}),
		});
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		expect(host.querySelector(".gui-session-info-plugin-status")).toBeNull();
		expect(host.querySelector(".gui-session-info-plugins-head")?.textContent).toContain("0/1");
		expect(host.querySelector(".gui-session-info-plugin-state")?.textContent).toBe(
			t("settings.extensionsStateDisabled"),
		);
		await unmount();
	});

	it("没有任何插件时状态条与分区都不渲染", async () => {
		const rpc = makeRpc({ "extensions.list": () => ({ extensions: [] }) });
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		expect(host.querySelector(".gui-session-info-plugins-group")).toBeNull();
		expect(host.querySelector(".gui-session-info-plugin-status")).toBeNull();
		expect(host.querySelector(".gui-session-info-plugins-head")).toBeNull();
		await unmount();
	});

	it("最后一个插件停用后状态条随 extensions.changed 消失", async () => {
		let extensions: Array<Record<string, unknown>> = [
			{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "active" },
		];
		const listeners: Array<(event: { payload?: unknown }) => void> = [];
		const rpc = {
			request: async (method: string): Promise<unknown> =>
				method === "extensions.list" ? { extensions } : method.startsWith("models.list") ? [] : {},
			addEventListener: (listener: (event: { payload?: unknown }) => void) => {
				listeners.push(listener);
				return () => {};
			},
		} as unknown as RpcClient;
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={rpc} />);
		expect(host.querySelector(".gui-session-info-plugin-status")).not.toBeNull();

		extensions = [{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "disabled" }];
		for (const listener of listeners) listener({ payload: { type: "extensions.changed" } });
		await flush();
		await flush();
		expect(host.querySelector(".gui-session-info-plugin-status")).toBeNull();
		expect(host.querySelector(".gui-session-info-plugins-head")?.textContent).toContain("0/1");
		await unmount();
	});
});

describe("SessionInfoCard 子代理与待办", () => {
	function progressPayload(
		id: string,
		agent: string,
		task: string,
		status: "running" | "completed",
		toolCount: number,
		cost = 0,
		durationMs = 0,
	): SubagentProgressPayload {
		return {
			index: 0,
			agent,
			task,
			progress: {
				index: 0,
				id,
				agent,
				status,
				task,
				recentTools: [],
				recentOutput: [],
				toolCount,
				requests: 0,
				tokens: 0,
				cost,
				durationMs,
			},
		};
	}

	it("列出运行中的子代理与进度条，已结束的折叠在计数后", async () => {
		const progress = new Map<string, SubagentProgressPayload>([
			["a", progressPayload("a", "explorer", "审查文件", "running", 2)],
			["b", progressPayload("b", "fixer", "修复缺陷", "completed", 5)],
		]);
		const opened: string[] = [];
		const { host, unmount } = await mount(
			<SessionInfoCard {...CARD_PROPS} rpc={makeRpc()} progress={progress} onOpenSurface={id => opened.push(id)} />,
		);
		const agents = host.querySelector<HTMLElement>(".gui-session-info-agents")!;
		expect(agents).not.toBeNull();
		expect(agents.textContent).toContain("explorer");
		expect(agents.textContent).toContain("审查文件");
		// The bar carries the shared progress fraction (2 tools → 2/4).
		expect(agents.querySelector<HTMLElement>(".gui-session-info-bar .tv-swarm-bar-fill")?.style.width).toBe("50%");
		expect(agents.textContent).toContain(t("general.ended"));
		expect(agents.textContent).toContain("1");
		// Ended rows mount behind the disclosure, not inline.
		const endedBody = agents.querySelector<HTMLElement>(".gui-collapse")!;
		expect(endedBody.getAttribute("aria-hidden")).toBe("true");

		await act(async () => {
			agents.querySelector<HTMLButtonElement>(".gui-session-info-agent--ended")!.click();
		});
		expect(endedBody.getAttribute("aria-hidden")).toBe("false");
		expect(host.querySelector(".gui-session-info-agents")!.textContent).toContain("fixer");
		await act(async () => {
			host.querySelectorAll<HTMLButtonElement>(".gui-session-info-agent")[0]!.click();
		});
		expect(opened).toEqual(["trajectory"]);
		await unmount();
	});

	it("已结束子代理显示耗时与成本", async () => {
		const progress = new Map<string, SubagentProgressPayload>([
			["c", progressPayload("c", "worker", "整理数据", "completed", 3, 0.42, 62_000)],
		]);
		const { host, unmount } = await mount(<SessionInfoCard {...CARD_PROPS} rpc={makeRpc()} progress={progress} />);
		await act(async () => {
			host.querySelector<HTMLButtonElement>(".gui-session-info-agent--ended")!.click();
		});
		const text = host.querySelector(".gui-session-info-agents")!.textContent ?? "";
		expect(text).toContain("1m02s");
		expect(text).toContain("$0.420");
		await unmount();
	});

	it("待办进行中显示当前任务与完成比，点行打开轨迹面；完成后 section 消失", async () => {
		const entries = (todoStatus: "in_progress" | "completed"): readonly SessionEntry[] =>
			[
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						isError: false,
						details: {
							phases: [
								{
									name: "阶段一",
									tasks: [
										{ content: "改代码", status: "completed" },
										{ content: "写测试", status: todoStatus },
									],
								},
							],
						},
					},
				},
			] as never;
		const opened: string[] = [];
		const view = await mount(
			<SessionInfoCard
				{...CARD_PROPS}
				rpc={makeRpc()}
				entries={entries("in_progress")}
				working={true}
				onOpenSurface={id => opened.push(id)}
			/>,
		);
		const section = view.host.querySelector<HTMLElement>(".gui-session-info-section")!;
		expect(section.textContent).toContain(t("general.todoProgress"));
		expect(section.textContent).toContain("写测试");
		expect(section.textContent).toContain("1/2");
		await act(async () => section.querySelector<HTMLButtonElement>(".gui-session-info-agent")!.click());
		expect(opened).toEqual(["trajectory"]);

		await view.rerender(
			<SessionInfoCard {...CARD_PROPS} rpc={makeRpc()} entries={entries("completed")} working={true} />,
		);
		expect(view.host.querySelector(".gui-session-info-section")).toBeNull();
		await view.unmount();
	});
});

/**
 * Mirrors app.tsx: keep the hook's latest state on the DOM.
 */
function VisibilityHost({ sessionId, panelOpen }: { sessionId: string | null; panelOpen: boolean }): ReactNode {
	const { open, toggle } = useSessionInfoCardVisibility({ sessionId, panelOpen });
	return (
		<>
			<span data-open={open ? "1" : "0"} />
			<button type="button" onClick={toggle}>
				toggle
			</button>
		</>
	);
}

function openState(host: HTMLElement): string | null {
	return host.querySelector("[data-open]")!.getAttribute("data-open");
}

describe("会话信息卡展开状态", () => {
	it("面板收起时默认显示，手动切换后按会话持久化", async () => {
		const view = await mount(<VisibilityHost sessionId="session-1" panelOpen={false} />);
		expect(openState(view.host)).toBe("1");
		await act(async () => view.host.querySelector("button")!.click());
		expect(openState(view.host)).toBe("0");
		expect(localStorage.getItem("musepi-gui-session-info-session-1")).toBe("0");
		await view.unmount();

		// Remount = reopening the session: the manual choice survives even though
		// the panel is still collapsed (whose default would show the card).
		const again = await mount(<VisibilityHost sessionId="session-1" panelOpen={false} />);
		expect(openState(again.host)).toBe("0");
		await again.unmount();
	});

	it("面板打开时默认隐藏，面板状态一变就覆盖手动态", async () => {
		const view = await mount(<VisibilityHost sessionId="session-2" panelOpen={false} />);
		await act(async () => view.host.querySelector("button")!.click());
		expect(openState(view.host)).toBe("0");

		// Panel expands: reset to that state's default (hidden), manual choice lost.
		await view.rerender(<VisibilityHost sessionId="session-2" panelOpen={true} />);
		expect(openState(view.host)).toBe("0");

		// Manual choice stands again until the panel next changes.
		await act(async () => view.host.querySelector("button")!.click());
		expect(openState(view.host)).toBe("1");
		await view.rerender(<VisibilityHost sessionId="session-2" panelOpen={true} />);
		expect(openState(view.host)).toBe("1");

		// Collapsing the panel shows the card again.
		await view.rerender(<VisibilityHost sessionId="session-2" panelOpen={false} />);
		expect(openState(view.host)).toBe("1");
		await view.unmount();
	});

	it("切换会话时读取该会话自己的偏好，而不是沿用上一个会话", async () => {
		const view = await mount(<VisibilityHost sessionId="session-a" panelOpen={false} />);
		await act(async () => view.host.querySelector("button")!.click());
		expect(openState(view.host)).toBe("0");

		// No stored preference for b: its default (panel collapsed) applies.
		await view.rerender(<VisibilityHost sessionId="session-b" panelOpen={false} />);
		expect(openState(view.host)).toBe("1");

		// Back to a: its own stored choice returns.
		await view.rerender(<VisibilityHost sessionId="session-a" panelOpen={false} />);
		expect(openState(view.host)).toBe("0");
		await view.unmount();
	});
});

/**
 * Mirrors the chat scene's real boxes: every element answers the same row width,
 * so the seat decision reads a deterministic value.
 */
function mockLayout({ rowWidth }: { rowWidth: number }): void {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return new DOMRect(0, 0, rowWidth, 600);
	});
}

describe("SessionInfoCard 座位", () => {
	it("停靠列不写浮卡几何，浮卡才写", async () => {
		const dock = await mount(<SessionInfoCard {...CARD_PROPS} rpc={makeRpc()} mode="dock" />);
		const dockEl = dock.host.querySelector<HTMLElement>(".gui-session-info")!;
		expect(dockEl.getAttribute("data-mode")).toBe("dock");
		expect(dockEl.classList.contains("gui-session-info--dock")).toBe(true);
		expect(dockEl.style.top).toBe("");
		expect(dockEl.style.maxHeight).toBe("");
		expect(dockEl.getAttribute("role")).toBe("region");
		expect(dockEl.getAttribute("aria-label")).toBe(t("sessionInfo.title"));
		await dock.unmount();

		const float = await mount(<SessionInfoCard {...CARD_PROPS} rpc={makeRpc()} top={154} />);
		const floatEl = float.host.querySelector<HTMLElement>(".gui-session-info")!;
		expect(floatEl.getAttribute("data-mode")).toBe("float");
		expect(floatEl.classList.contains("gui-session-info--float")).toBe(true);
		expect(floatEl.style.top).toBe("154px");
		expect(floatEl.style.maxHeight).toBe(`calc(100% - ${154 + 12}px)`);
		await float.unmount();
	});
});

describe("会话信息卡层级与座位几何", () => {
	it("浮卡是会话列内的绝对定位层，停靠列脱离浮层", () => {
		const style = document.createElement("style");
		style.textContent = fs.readFileSync(path.resolve(import.meta.dir, "../src/styles/gui-chat.css"), "utf8");
		document.head.appendChild(style);
		const host = document.createElement("div");
		host.innerHTML = `
			<div class="gui-transcript-wrap">
				<div class="gui-session-info gui-session-info--float"></div>
				<div class="gui-session-info gui-session-info--dock"></div>
			</div>`;
		document.body.appendChild(host);

		const float = getComputedStyle(host.querySelector<HTMLElement>(".gui-session-info--float")!);
		const dock = getComputedStyle(host.querySelector<HTMLElement>(".gui-session-info--dock")!);

		// Below the header tool cluster (30), menus and tooltips.
		expect(Number(float.zIndex)).toBe(3);
		expect(float.position).toBe("absolute");
		expect(float.right).toBe("12px");
		// The dock is an in-flow card, not an overlay: nothing to stack against.
		expect(dock.position).toBe("relative");
		expect(dock.width).toBe(`${SESSION_INFO_DOCK_WIDTH_PX}px`);
		// Content-sized in both themes: a stretched column painted a tall empty
		// card in dark mode. The cap keeps it inside the row's gutters.
		expect(dock.alignSelf).toBe("flex-start");
		expect(dock.maxHeight).toBe("calc(100% - 8px * 2)");
		// The shared card gutter, resolved: the dock sits in the same row rhythm
		// as the chat column and the right panel.
		expect(dock.marginLeft).toBe("8px");
		expect(dock.overflowY).toBe("auto");

		host.remove();
	});
});

describe("ChatView 会话信息卡座位", () => {
	function chatStore(): GuiSessionStore {
		return new GuiSessionStore("session-1", { entries: [], cursor: 0 } as never, "C:/workspace");
	}

	function renderChat(opts: {
		sessionInfoOpen: boolean;
		rightPanelOpen: boolean;
		onToggleSessionInfo?: () => void;
		rpc?: RpcClient;
	}): ReactNode {
		return (
			<ChatView
				store={chatStore()}
				rpc={opts.rpc ?? makeRpc({ "git.numstat": () => ({ files: [] }) })}
				onSend={() => {}}
				onStop={() => {}}
				onDecideApproval={() => {}}
				busy={false}
				project="C:/workspace"
				onProject={() => {}}
				onSubmitNewSession={() => {}}
				rightPanelOpen={opts.rightPanelOpen}
				terminalOpen={false}
				focusMode={false}
				onToggleFocus={() => {}}
				sessionTitle="修复会话信息卡"
				sessionInfoOpen={opts.sessionInfoOpen}
				onToggleSessionInfo={opts.onToggleSessionInfo}
			/>
		);
	}

	it("面板收起：宽行下渲染独立停靠列，位于会话列与右面板/rail 之间", async () => {
		mockLayout({ rowWidth: 1200 });
		const view = await mount(renderChat({ sessionInfoOpen: true, rightPanelOpen: false }));
		const column = view.host.querySelector<HTMLElement>(".gui-chat-column")!;
		const card = view.host.querySelector<HTMLElement>(".gui-session-info--dock");
		expect(card).not.toBeNull();
		// Outside the chat column: a dock must never overlay the transcript.
		expect(card!.closest(".gui-chat-column")).toBeNull();
		expect(column.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		const rail = view.host.querySelector<HTMLElement>(".gui-right-rail")!;
		expect(card!.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		expect(view.host.querySelector(".gui-session-info--float")).toBeNull();
		await view.unmount();
	});

	it("面板展开：浮卡落在会话列内，起点在 surface 模式行之下", async () => {
		mockLayout({ rowWidth: 1200 });
		const view = await mount(renderChat({ sessionInfoOpen: true, rightPanelOpen: true }));
		const card = view.host.querySelector<HTMLElement>(".gui-session-info--float");
		expect(card).not.toBeNull();
		expect(card!.closest(".gui-chat-column")).not.toBeNull();
		// Default float geometry: below the surface-mode row (44px + one gap
		// is folded into the default; the status-card stack is gone).
		expect(card!.style.top).toBe("44px");
		// The old status-card stack is gone from the scene entirely.
		expect(view.host.querySelector(".gui-status-cards")).toBeNull();
		expect(view.host.querySelector(".gui-session-info--dock")).toBeNull();
		await view.unmount();
	});

	it("面板收起但行太窄：回退为浮卡，不挤压会话列", async () => {
		mockLayout({ rowWidth: 600 });
		const view = await mount(renderChat({ sessionInfoOpen: true, rightPanelOpen: false }));
		expect(view.host.querySelector(".gui-session-info--float")).not.toBeNull();
		expect(view.host.querySelector(".gui-session-info--dock")).toBeNull();
		await view.unmount();
	});

	it("头部按钮切换座位，收起时不渲染任何座位", async () => {
		mockLayout({ rowWidth: 1200 });
		let toggles = 0;
		const shown = await mount(
			renderChat({ sessionInfoOpen: true, rightPanelOpen: false, onToggleSessionInfo: () => toggles++ }),
		);
		const button = shown.host.querySelector<HTMLButtonElement>(".gui-chat-info-toggle")!;
		expect(button).not.toBeNull();
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(button.getAttribute("title")).toBe(t("general.sessionInfoHide"));
		expect(shown.host.querySelector(".gui-session-info")).not.toBeNull();
		await act(async () => button.click());
		expect(toggles).toBe(1);
		await shown.unmount();

		const hidden = await mount(
			renderChat({ sessionInfoOpen: false, rightPanelOpen: false, onToggleSessionInfo: () => {} }),
		);
		expect(hidden.host.querySelector(".gui-session-info")).toBeNull();
		expect(hidden.host.querySelector(".gui-chat-info-toggle")?.getAttribute("aria-pressed")).toBe("false");
		expect(hidden.host.querySelector(".gui-chat-info-toggle")?.getAttribute("title")).toBe(
			t("general.sessionInfoShow"),
		);
		await hidden.unmount();
	});

	it("连接器与插件入口只留在信息卡：输入框与旧状态卡不再有第二套", async () => {
		mockLayout({ rowWidth: 1200 });
		const rpc = makeRpc({
			"git.numstat": () => ({ files: [] }),
			"connectors.list": () => ({
				servers: [{ name: "fs", transport: "stdio", status: "connected" }],
				selected: null,
			}),
			"extensions.list": () => ({
				extensions: [{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "active" }],
			}),
		});
		const view = await mount(renderChat({ sessionInfoOpen: true, rightPanelOpen: false, rpc }));
		const card = view.host.querySelector<HTMLElement>(".gui-session-info--dock")!;
		expect(card.querySelector(".gui-connector-panel")).not.toBeNull();
		expect(card.querySelector(".gui-session-info-plugins")).not.toBeNull();
		// One picker in the whole scene: the composer's chip and the retired
		// status-card stack are gone.
		expect(view.host.querySelectorAll(".gui-connector-panel")).toHaveLength(1);
		expect(view.host.querySelector(".gui-connector-chip")).toBeNull();
		expect(view.host.querySelector(".gui-ext-status-menu")).toBeNull();
		expect(view.host.querySelector(".gui-status-cards")).toBeNull();
		await view.unmount();
	});
});
