import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type MarketplaceCardEntry, setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MarketplaceView } from "../src/components/MarketplaceView";
import { PromptProvider } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";

/**
 * 插件详情页的版本选择契约（GUI）：
 * 1. 详情页列出仓库发布的版本，已装版本带「当前」标记且不可选；
 *    catalog 最新版本默认选中，更旧的版本渲染但禁用（降级入口不提供）。
 * 2. 主操作按选中版本给出「升级到 vX」，确认框写清 from → to。
 * 3. 升级请求带 targetVersion 与 expectedVersion（用户看到的版本）；
 *    没有版本列表时回退到既有的「升到 catalog 版本」语义。
 * 4. catalog 换源时确认框改为「重新安装」，请求带 replace: true。
 */

setLocale("zh-CN");

/** Roots still mounted when a test ends (also the ones that failed mid-way). */
const mounted: Array<() => Promise<void>> = [];

beforeEach(() => {
	localStorage.clear();
});
afterEach(async () => {
	for (const unmount of mounted.splice(0)) await unmount();
	document.querySelectorAll(".gui-dialog-backdrop").forEach(node => node.remove());
});
afterAll(() => {
	setLocale("en-US");
});

const BASE: MarketplaceCardEntry = {
	name: "hello-plugin",
	marketplace: "test-marketplace",
	version: "2.0.0",
	installed: true,
	installedScope: "user",
	installedVersion: "1.5.0",
	updateAvailable: true,
};

interface Harness {
	rpc: RpcClient;
	requestSpy: ReturnType<typeof spyOn>;
	unmount(): Promise<void>;
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

async function openView(detail: Record<string, unknown>): Promise<Harness> {
	const impl = {
		request: async (method: string): Promise<unknown> => {
			if (method === "marketplace.list") return { entries: [BASE] };
			if (method === "marketplace.sources.list") return { sources: [] };
			if (method === "marketplace.detail") return detail;
			if (method === "marketplace.upgrade") return { ok: true, upgraded: [] };
			throw new Error(`unexpected rpc: ${method}`);
		},
	};
	const requestSpy = spyOn(impl, "request");
	const rpc = impl as unknown as RpcClient;

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(PromptProvider, null, createElement(MarketplaceView, { rpc })));
	});
	await flush();
	await flush();

	// Card → 详情. The detail dialog re-reads marketplace.detail once it opens.
	const card = document.querySelector<HTMLElement>("[data-marketplace-card='hello-plugin']");
	expect(card).not.toBeNull();
	const details = [...card!.querySelectorAll<HTMLButtonElement>(".mp-card-actions button")].find(
		button => button.textContent === t("guest.pluginDetails"),
	);
	expect(details).toBeDefined();
	await act(async () => {
		details!.click();
	});
	await flush();
	await flush();

	const unmount = async (): Promise<void> => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	mounted.push(unmount);
	return { rpc, requestSpy, unmount };
}

function versionButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>(".gui-marketplace-detail .mp-version")];
}

function footerUpgrade(): HTMLButtonElement | undefined {
	return [...document.querySelectorAll<HTMLButtonElement>(".gui-marketplace-detail-actions button")].find(button =>
		button.className.includes("gui-btn-primary"),
	);
}

/** Title of the confirmation dialog — the detail dialog has its own h3 section headings. */
function confirmTitle(): string | undefined {
	return document.querySelector<HTMLElement>(".gui-dialog--confirm h3")?.textContent ?? undefined;
}

async function clickOk(): Promise<void> {
	const ok = document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary");
	expect(ok).not.toBeNull();
	await act(async () => {
		ok!.click();
	});
	await sleep(250); // 确认框 180ms 退出动画后才解析 promise
}

describe("插件详情版本选择", () => {
	test("列出版本、标记当前、禁用降级，并按选中版本升级", async () => {
		const h = await openView({
			...BASE,
			displayName: "Hello",
			versions: ["2.0.0", "1.5.0", "1.0.0"],
			sourceChanged: false,
		});

		expect(callsOf(h.requestSpy, "marketplace.detail")).toEqual([
			{ name: "hello-plugin", marketplace: "test-marketplace" },
		]);

		const versions = versionButtons();
		expect(versions.map(button => button.textContent)).toEqual([
			"v2.0.0",
			`v1.5.0${t("marketplace.versionCurrent")}`,
			"v1.0.0",
		]);
		// Installed version and older ones cannot be picked.
		expect(versions[1]!.disabled).toBe(true);
		expect(versions[2]!.disabled).toBe(true);
		expect(versions[2]!.title).toBe(t("marketplace.versionDowngradeBlocked"));
		// Newest is the default target.
		expect(versions[0]!.getAttribute("aria-checked")).toBe("true");
		expect(footerUpgrade()?.textContent).toBe(t("marketplace.upgradeToVersion", { version: "2.0.0" }));

		// A disabled older chip does not move the selection.
		await act(async () => {
			versions[2]!.click();
		});
		expect(versions[0]!.getAttribute("aria-checked")).toBe("true");

		await act(async () => {
			footerUpgrade()!.click();
		});
		expect(confirmTitle()).toBe(
			t("guest.marketplaceUpgradeConfirm", {
				name: "hello-plugin",
				from: "1.5.0",
				to: "2.0.0",
				source: "test-marketplace",
			}),
		);

		await clickOk();
		expect(callsOf(h.requestSpy, "marketplace.upgrade")).toEqual([
			{
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				targetVersion: "2.0.0",
				expectedVersion: "2.0.0",
			},
		]);

		await h.unmount();
	});

	test("选择中间版本时按该版本升级", async () => {
		const h = await openView({
			...BASE,
			installedVersion: "1.0.0",
			versions: ["2.0.0", "1.5.0", "1.0.0"],
			sourceChanged: false,
		});

		const versions = versionButtons();
		await act(async () => {
			versions[1]!.click();
		});
		expect(versions[1]!.getAttribute("aria-checked")).toBe("true");
		expect(footerUpgrade()?.textContent).toBe(t("marketplace.upgradeToVersion", { version: "1.5.0" }));

		await act(async () => {
			footerUpgrade()!.click();
		});
		expect(confirmTitle()).toBe(
			t("guest.marketplaceUpgradeConfirm", {
				name: "hello-plugin",
				from: "1.0.0",
				to: "1.5.0",
				source: "test-marketplace",
			}),
		);

		await clickOk();
		expect(callsOf(h.requestSpy, "marketplace.upgrade")).toEqual([
			{
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				targetVersion: "1.5.0",
				expectedVersion: "2.0.0",
			},
		]);

		await h.unmount();
	});

	test("catalog 换源时走重新安装确认，并带 replace", async () => {
		const h = await openView({
			...BASE,
			versions: ["2.0.0", "1.5.0"],
			sourceChanged: true,
		});

		await act(async () => {
			footerUpgrade()!.click();
		});
		expect(confirmTitle()).toBe(
			t("marketplace.replaceConfirm", {
				name: "hello-plugin",
				source: "test-marketplace",
				version: "2.0.0",
			}),
		);

		await clickOk();
		expect(callsOf(h.requestSpy, "marketplace.upgrade")).toEqual([
			{
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				targetVersion: "2.0.0",
				expectedVersion: "2.0.0",
				replace: true,
			},
		]);

		await h.unmount();
	});

	test("没有版本列表时保留既有的 latest 升级入口", async () => {
		const h = await openView({ ...BASE, versions: [], sourceChanged: false });

		expect(versionButtons()).toEqual([]);
		expect(footerUpgrade()?.textContent).toBe(t("guest.pluginUpgrade"));

		await act(async () => {
			footerUpgrade()!.click();
		});
		await clickOk();
		// No chosen version: the wire shape stays exactly the pre-existing one.
		expect(callsOf(h.requestSpy, "marketplace.upgrade")).toEqual([
			{
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
			},
		]);

		await h.unmount();
	});
});
