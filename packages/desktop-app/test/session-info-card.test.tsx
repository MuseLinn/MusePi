import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { SessionInfoCard, useSessionInfoCardVisibility } from "../src/components/session-info-card";
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
	localStorage.clear();
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
		const more = host.querySelector<HTMLButtonElement>(".gui-session-info-more")!;
		expect(more.textContent).toContain(t("general.sessionInfoMore", { count: 2 }));
		await act(async () => more.click());
		expect(host.querySelectorAll(".gui-session-info-item")).toHaveLength(8);
		expect(host.querySelector(".gui-session-info-more")).toBeNull();
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

/** Mirrors app.tsx: keep the hook's latest state on the DOM. */
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

describe("ChatView 会话信息卡接线", () => {
	function chatStore(): GuiSessionStore {
		return new GuiSessionStore("session-1", { entries: [], cursor: 0 } as never, "C:/workspace");
	}

	function renderChat(sessionInfoOpen: boolean, onToggleSessionInfo: () => void): ReactNode {
		return (
			<ChatView
				store={chatStore()}
				rpc={makeRpc({ "git.numstat": () => ({ files: [] }) })}
				onSend={() => {}}
				onStop={() => {}}
				onDecideApproval={() => {}}
				busy={false}
				project="C:/workspace"
				onProject={() => {}}
				onSubmitNewSession={() => {}}
				rightPanelOpen={false}
				terminalOpen={false}
				focusMode={false}
				onToggleFocus={() => {}}
				sessionTitle="修复会话信息卡"
				sessionInfoOpen={sessionInfoOpen}
				onToggleSessionInfo={onToggleSessionInfo}
			/>
		);
	}

	it("头部按钮切换浮卡，收起时不渲染", async () => {
		let toggles = 0;
		const shown = await mount(renderChat(true, () => toggles++));
		const button = shown.host.querySelector<HTMLButtonElement>(".gui-chat-info-toggle")!;
		expect(button).not.toBeNull();
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(button.getAttribute("title")).toBe(t("general.sessionInfoHide"));
		expect(shown.host.querySelector(".gui-session-info")).not.toBeNull();
		await act(async () => button.click());
		expect(toggles).toBe(1);
		await shown.unmount();

		const hidden = await mount(renderChat(false, () => {}));
		expect(hidden.host.querySelector(".gui-session-info")).toBeNull();
		expect(hidden.host.querySelector(".gui-chat-info-toggle")?.getAttribute("title")).toBe(
			t("general.sessionInfoShow"),
		);
		await hidden.unmount();
	});
});
