import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { type MarketplaceCardEntry, setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MarketplaceView } from "../src/components/MarketplaceView";
import { PromptProvider } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";

/**
 * 市场安装/卸载/升级的信任确认契约（GUI）：
 * 1. 三个动作都先弹确认框，且确认框写清「来源 marketplace」与版本 ——
 *    安装显示 catalog 版本，卸载显示已装版本，升级显示 from → to。
 * 2. 取消不发起任何 RPC；确认后参数带 scope（卸载/升级）与
 *    expectedVersion（安装），daemon 侧据此拒绝 catalog 漂移。
 * 3. 「全部升级」一次确认整批（带数量），只发一条 marketplace.upgrade
 *    { all: true }，不逐卡弹窗。
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const INSTALLABLE: MarketplaceCardEntry = {
	name: "pdf-toolkit",
	marketplace: "test-marketplace",
	version: "2.0.0",
	description: "PDF helper",
};

const OUTDATED: MarketplaceCardEntry = {
	name: "hello-plugin",
	marketplace: "test-marketplace",
	version: "2.0.0",
	description: "Greets",
	installed: true,
	installedScope: "user",
	installedVersion: "1.0.0",
	updateAvailable: true,
};

function makeRpc(entries: MarketplaceCardEntry[]): { rpc: RpcClient; requestSpy: ReturnType<typeof spyOn> } {
	const impl = {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			if (method === "marketplace.list") return { entries };
			if (method === "marketplace.sources.list") return { sources: [] };
			if (method === "marketplace.install") return { ok: true, installed: true };
			if (method === "marketplace.remove") return { ok: true };
			if (method === "marketplace.upgrade") return { ok: true, upgraded: [] };
			throw new Error(`unexpected rpc: ${method} ${JSON.stringify(params)}`);
		},
	};
	const requestSpy = spyOn(impl, "request");
	return { rpc: impl as unknown as RpcClient, requestSpy };
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

async function sleep(ms: number): Promise<void> {
	await act(async () => {
		await new Promise(r => setTimeout(r, ms));
	});
}

function callsOf(requestSpy: ReturnType<typeof spyOn>, method: string): unknown[] {
	return requestSpy.mock.calls.filter((c: unknown[]) => c[0] === method).map((c: unknown[]) => c[1]);
}

async function renderView(rpc: RpcClient): Promise<{ unmount(): Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(PromptProvider, null, createElement(MarketplaceView, { rpc })));
	});
	await flush();
	await flush();
	return {
		async unmount() {
			await act(async () => {
				root.unmount();
			});
			host.remove();
		},
	};
}

function card(name: string): HTMLElement {
	const found = [...document.querySelectorAll<HTMLElement>(".mp-card")].find(
		c => c.querySelector(".mp-card-name")?.textContent === name,
	);
	expect(found).toBeDefined();
	return found!;
}

function cardButton(name: string, label: string): HTMLButtonElement {
	const found = [...card(name).querySelectorAll<HTMLButtonElement>(".mp-card-actions button")].find(
		b => b.textContent === label,
	);
	expect(found).toBeDefined();
	return found!;
}

function dialogTitle(): string {
	const title = document.querySelector<HTMLElement>(".gui-dialog-backdrop .gui-dialog h3");
	expect(title).not.toBeNull();
	return title!.textContent ?? "";
}

async function clickOk(): Promise<void> {
	const ok = document.querySelector<HTMLElement>(".gui-dialog-backdrop .gui-btn-primary");
	expect(ok).not.toBeNull();
	await act(async () => {
		ok!.click();
	});
	await sleep(250); // 确认框 180ms 退出动画后才解析 promise
}

describe("市场安装信任确认", () => {
	test("确认框展示来源与 catalog 版本；取消不发安装，确认带 expectedVersion", async () => {
		const { rpc, requestSpy } = makeRpc([INSTALLABLE]);
		const { unmount } = await renderView(rpc);

		await act(async () => {
			cardButton("pdf-toolkit", t("guest.pluginInstall")).click();
		});
		expect(dialogTitle()).toBe(
			t("guest.marketplaceInstallConfirmWithVersion", {
				name: "pdf-toolkit",
				version: "2.0.0",
				source: "test-marketplace",
			}),
		);

		const cancel = document.querySelector<HTMLElement>(".gui-dialog-backdrop .gui-btn:not(.gui-btn-primary)");
		expect(cancel).not.toBeNull();
		await act(async () => {
			cancel!.click();
		});
		await sleep(250);
		expect(callsOf(requestSpy, "marketplace.install")).toHaveLength(0);

		await act(async () => {
			cardButton("pdf-toolkit", t("guest.pluginInstall")).click();
		});
		await clickOk();
		expect(callsOf(requestSpy, "marketplace.install")).toEqual([
			{ name: "pdf-toolkit", marketplace: "test-marketplace", expectedVersion: "2.0.0" },
		]);

		await unmount();
		document.querySelector(".gui-dialog-backdrop")?.remove();
	});
});

describe("市场卸载/升级信任确认", () => {
	test("卸载确认展示已装版本并带 scope；升级确认展示 from → to 并发 pluginId", async () => {
		const { rpc, requestSpy } = makeRpc([OUTDATED]);
		const { unmount } = await renderView(rpc);

		await act(async () => {
			cardButton("hello-plugin", t("guest.pluginRemove")).click();
		});
		expect(dialogTitle()).toBe(
			t("guest.marketplaceRemoveConfirmWithVersion", {
				name: "hello-plugin",
				version: "1.0.0",
				source: "test-marketplace",
			}),
		);
		await clickOk();
		expect(callsOf(requestSpy, "marketplace.remove")).toEqual([
			{ name: "hello-plugin", marketplace: "test-marketplace", scope: "user" },
		]);

		await act(async () => {
			cardButton("hello-plugin", t("guest.pluginUpgrade")).click();
		});
		expect(dialogTitle()).toBe(
			t("guest.marketplaceUpgradeConfirm", {
				name: "hello-plugin",
				from: "1.0.0",
				to: "2.0.0",
				source: "test-marketplace",
			}),
		);
		await clickOk();
		expect(callsOf(requestSpy, "marketplace.upgrade")).toEqual([
			{ pluginId: "hello-plugin@test-marketplace", scope: "user" },
		]);

		await unmount();
		document.querySelector(".gui-dialog-backdrop")?.remove();
	});
});

describe("市场全部升级确认", () => {
	test("一次确认整批，只发一条 upgrade { all: true }", async () => {
		const { rpc, requestSpy } = makeRpc([INSTALLABLE, OUTDATED]);
		const { unmount } = await renderView(rpc);

		const upgradeAll = [...document.querySelectorAll<HTMLButtonElement>(".mp-grid-toolbar button")].find(
			b => b.textContent === t("guest.pluginUpgradeAll"),
		);
		expect(upgradeAll).toBeDefined();
		await act(async () => {
			upgradeAll!.click();
		});
		expect(dialogTitle()).toBe(t("guest.marketplaceUpgradeAllConfirm", { count: 1 }));
		await clickOk();

		expect(callsOf(requestSpy, "marketplace.upgrade")).toEqual([{ all: true }]);

		await unmount();
		document.querySelector(".gui-dialog-backdrop")?.remove();
	});
});
