import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setLocale, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { collectSlotComponents } from "../../coding-agent/src/daemon/extension-artifact-compiler";
import { assertKnownComponentSlot } from "../../coding-agent/src/extensibility/extensions/loader";
import { SessionInfoCard } from "../src/components/session-info-card";
import type { PanelTab } from "../src/lib/panel-tabs";
import type { RpcClient } from "../src/lib/rpc";
import { SESSION_INFO_SLOT, SESSION_INFO_SLOT_PREFIX } from "../src/lib/slot-host";
import { apply } from "../src/plugins/session-info-plugins";
import SessionInfoPluginsSection from "../src/plugins/session-info-plugins/page";

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

type Handler = (params: Record<string, unknown>) => unknown;

/** Fake daemon: unknown methods answer `{}` so the card's boot effects settle. */
function makeRpc(handlers: Partial<Record<string, Handler>> = {}): RpcClient {
	return {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			const handler = handlers[method];
			if (handler) return handler((params ?? {}) as Record<string, unknown>);
			return method.startsWith("models.list") ? [] : {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function mount(node: ReactNode): Promise<{ host: HTMLElement; unmount(): Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(node);
	});
	await flush();
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const PLUGIN_EXTENSIONS = [
	{ id: "alpha", kind: "plugin-module", name: "alpha", displayName: "Alpha", state: "active" },
	{ id: "beta", kind: "plugin-module", name: "beta", displayName: "beta", state: "disabled" },
	{ id: "gamma", kind: "extension-module", name: "gamma", displayName: "Gamma", state: "active" },
	{ id: "theme", kind: "theme-pack", name: "theme", displayName: "Theme", state: "active" },
];

const CARD_PROPS = {
	sessionId: "session-1",
	cwd: "C:/workspace",
	title: "修复会话信息卡",
	tabs: [] as PanelTab[],
};

const SECTION_DATA = {
	runningPlugins: 2,
	pluginEntries: [
		{ id: "alpha", label: "Alpha", active: true },
		{ id: "beta", label: "Beta", active: false },
	],
};

describe("session-info-plugins Cordis 插件", () => {
	it("注册 chat.session-info.plugins 分区", () => {
		const components: Array<{ slot: string; moduleUrl: string; label?: string }> = [];
		apply({
			setLabel() {},
			registerComponent(component) {
				components.push(component);
			},
		});
		expect(components).toEqual([{ slot: SESSION_INFO_SLOT, moduleUrl: "./page.tsx", label: "插件" }]);
		expect(SESSION_INFO_SLOT.startsWith(SESSION_INFO_SLOT_PREFIX)).toBe(true);
		// daemon 的注册校验与 GUI 共用同一份槽位声明:前缀没声明时,插件整体
		// 加载失败(slot-host 里挂载不了任何东西),卡片只剩内置回退。
		expect(() => assertKnownComponentSlot(SESSION_INFO_SLOT)).not.toThrow();
	});

	it("从宿主下发的 sessionInfo 渲染运行计数与可展开列表", async () => {
		const { host, unmount } = await mount(createElement(SessionInfoPluginsSection, { sessionInfo: SECTION_DATA }));
		const head = host.querySelector<HTMLButtonElement>(".gui-session-info-plugins-head")!;
		expect(head.textContent).toContain(t("general.sessionInfoPlugins"));
		expect(head.textContent).toContain("2/2");
		expect(head.getAttribute("aria-expanded")).toBe("false");

		await act(async () => head.click());
		expect(head.getAttribute("aria-expanded")).toBe("true");
		const rows = [...host.querySelectorAll(".gui-session-info-plugin")].map(node => node.textContent);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("Alpha");
		expect(rows[0]).toContain(t("settings.extensionsStateRunning"));
		expect(rows[1]).toContain("Beta");
		expect(rows[1]).toContain(t("settings.extensionsStateDisabled"));
		await unmount();
	});

	it("编译失败的分区不占座位：卡片回退内置插件列表", async () => {
		const rpc = makeRpc({
			"extensions.list": () => ({
				extensions: PLUGIN_EXTENSIONS,
				components: [{ slot: SESSION_INFO_SLOT, extensionId: "/plugins/broken", code: "", error: "boom" }],
			}),
		});
		const { host, unmount } = await mount(createElement(SessionInfoCard, { ...CARD_PROPS, rpc }));
		expect(host.querySelector(".gui-slot-error")).toBeNull();
		const head = host.querySelector<HTMLButtonElement>(".gui-session-info-plugins-head")!;
		expect(head.textContent).toContain("2/3");

		await act(async () => head.click());
		const rows = [...host.querySelectorAll(".gui-session-info-plugin")].map(node => node.textContent);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("Alpha");
		await unmount();
	});

	it("卡片把同一份插件读数传给挂载的分区组件", async () => {
		const rpc = makeRpc({
			"extensions.list": () => ({
				extensions: PLUGIN_EXTENSIONS,
				components: [
					{
						slot: SESSION_INFO_SLOT,
						extensionId: "/plugins/session-info-plugins/index.ts",
						code: `export default function Section({ sessionInfo }) {
							const summary = sessionInfo.pluginEntries
								.map(entry => entry.label + (entry.active ? "*" : ""))
								.join(",");
							return window.MusePiReact.createElement(
								"div",
								{ className: "probe-section" },
								sessionInfo.runningPlugins + "/" + sessionInfo.pluginEntries.length + ":" + summary,
							);
						}`,
					},
				],
			}),
		});
		const { host, unmount } = await mount(createElement(SessionInfoCard, { ...CARD_PROPS, rpc }));
		await act(async () => Bun.sleep(20));
		await flush();
		expect(host.querySelectorAll(".gui-session-info-plugins")).toHaveLength(0);
		expect(host.querySelector(".probe-section")?.textContent).toBe("2/3:Alpha*,beta,Gamma*");
		await unmount();
	});
});

describe("session-info-plugins 真实加载管线", () => {
	it("内置发现加载 index.ts 后编译出可渲染的分区组件", async () => {
		// 走 daemon 的真实加载/编译路径:槽位校验、apply 注册与模块编译都在这条
		// 线上,卡片拿到的就是这里的 code。
		const components = await collectSlotComponents(
			[{ kind: "plugin-module", state: "active", path: path.resolve("src/plugins/session-info-plugins/index.ts") }],
			process.cwd(),
		);
		expect(components.map(item => ({ slot: item.slot, error: item.error }))).toEqual([
			{ slot: SESSION_INFO_SLOT, error: undefined },
		]);
		const module = await import(`data:text/javascript;base64,${Buffer.from(components[0]!.code).toString("base64")}`);
		const markup = renderToStaticMarkup(
			createElement(module.default as (props: unknown) => ReactNode, { sessionInfo: SECTION_DATA }),
		);
		expect(markup).toContain(t("general.sessionInfoPlugins"));
		expect(markup).toContain("2/2");
		expect(markup).toContain("Alpha");
	}, 60_000);
});
