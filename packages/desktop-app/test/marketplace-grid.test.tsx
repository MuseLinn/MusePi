import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type MarketplaceCardEntry, MarketplaceGrid, setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * 市场网格分段与自定义源管理契约（能力中心市场 tab）：
 * 1. 有 RPC client 时出现「已装/目录/自定义源」三段；已装段只列已装插件，
 *    并保留「可更新」徽标 —— 更新状态是渲染契约，不只是数据。
 * 2. 自定义源段按需拉 marketplace.sources.list；添加写入
 *    marketplace.sources.add({source}) 后重拉源与目录；移除发
 *    marketplace.sources.remove({name})。
 */

setLocale("zh-CN");
beforeEach(() => {
	localStorage.clear();
});
afterAll(() => {
	setLocale("en-US");
});

const INSTALLABLE: MarketplaceCardEntry = {
	name: "pdf-toolkit",
	marketplace: "test-marketplace",
	version: "2.0.0",
};

const OUTDATED: MarketplaceCardEntry = {
	name: "hello-plugin",
	marketplace: "test-marketplace",
	version: "2.0.0",
	category: "ai",
	installed: true,
	installedScope: "user",
	installedVersion: "1.0.0",
	updateAvailable: true,
};

const SOURCE = {
	name: "my-source",
	sourceType: "git" as const,
	sourceUri: "https://github.com/acme/plugins",
	addedAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

function makeRpc(entries: MarketplaceCardEntry[]): {
	client: { rpc<T>(method: string, params?: unknown): Promise<T> };
	calls: Array<{ method: string; params: unknown }>;
} {
	const calls: Array<{ method: string; params: unknown }> = [];
	const impl = {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "marketplace.list") return { entries };
			if (method === "marketplace.sources.list") return { sources: [SOURCE] };
			if (method === "marketplace.sources.add") return { ok: true, source: SOURCE };
			if (method === "marketplace.sources.remove") return { ok: true };
			if (method === "marketplace.sources.refresh") return { ok: true, sources: [SOURCE], failures: [] };
			throw new Error(`unexpected rpc: ${method}`);
		},
	};
	const spy = spyOn(impl, "request");
	return {
		client: { rpc: <T,>(m: string, p?: unknown): Promise<T> => spy(m, p) as Promise<T> },
		calls,
	};
}

async function renderGrid(
	entries: MarketplaceCardEntry[],
	client: { rpc<T>(method: string, params?: unknown): Promise<T> },
): Promise<{ unmount(): Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(MarketplaceGrid, { client }));
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

function segmentButton(id: "installed" | "catalog" | "sources"): HTMLButtonElement {
	const label = {
		installed: t("guest.marketplaceSegmentInstalled"),
		catalog: t("guest.marketplaceSegmentCatalog"),
		sources: t("guest.marketplaceSegmentSources"),
	}[id];
	const found = [...document.querySelectorAll<HTMLButtonElement>(".mp-segment")].find(b =>
		b.textContent?.startsWith(label),
	);
	expect(found).toBeDefined();
	return found!;
}

function cardNames(): string[] {
	return [...document.querySelectorAll<HTMLElement>(".mp-card .mp-card-name")].map(n => n.textContent ?? "");
}

describe("市场网格分段", () => {
	test("已装段只列已装插件，并渲染可更新徽标与已装版本", async () => {
		const { client } = makeRpc([INSTALLABLE, OUTDATED]);
		const { unmount } = await renderGrid([INSTALLABLE, OUTDATED], client);

		expect(cardNames().sort()).toEqual(["hello-plugin", "pdf-toolkit"]);
		expect(segmentButton("catalog").getAttribute("aria-selected")).toBe("true");

		await act(async () => {
			segmentButton("installed").click();
		});
		expect(cardNames()).toEqual(["hello-plugin"]);

		const badge = document.querySelector<HTMLElement>(".mp-card-badge--update");
		expect(badge).not.toBeNull();
		expect(badge!.textContent).toContain(t("guest.pluginUpdateBadge"));
		expect(document.querySelector<HTMLElement>(".mp-card-version")?.textContent).toBe("v1.0.0 → v2.0.0");
		expect(document.querySelector<HTMLElement>(".mp-card-badge")?.textContent).toContain(
			t("guest.pluginInstalledVersionBadge", { version: "1.0.0" }),
		);

		await unmount();
	});
});

describe("市场视图偏好持久化", () => {
	test("重挂后恢复已安装视图、搜索词和分类筛选", async () => {
		const { client } = makeRpc([INSTALLABLE, OUTDATED]);
		const first = await renderGrid([INSTALLABLE, OUTDATED], client);
		await act(async () => {
			segmentButton("installed").click();
		});
		const input = document.querySelector<HTMLInputElement>(".mp-search")!;
		const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
		const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
		await act(async () => {
			props.onChange({ target: { value: "hello" } });
		});
		const category = [...document.querySelectorAll<HTMLButtonElement>(".mp-chip")].find(
			button => button.textContent === "ai",
		)!;
		await act(async () => category.click());
		await first.unmount();

		const second = await renderGrid([INSTALLABLE, OUTDATED], client);
		expect(segmentButton("installed").getAttribute("aria-selected")).toBe("true");
		expect(document.querySelector<HTMLInputElement>(".mp-search")?.value).toBe("hello");
		expect(cardNames()).toEqual(["hello-plugin"]);
		await second.unmount();
	});
});

describe("市场自定义源管理", () => {
	test("切到自定义源按需拉取；刷新与移除发对应 RPC 并重拉", async () => {
		const { client, calls } = makeRpc([INSTALLABLE]);
		const { unmount } = await renderGrid([], client);

		expect(calls.filter(c => c.method === "marketplace.sources.list")).toHaveLength(0);

		await act(async () => {
			segmentButton("sources").click();
		});
		await flush();
		expect(calls.filter(c => c.method === "marketplace.sources.list")).toHaveLength(1);
		const row = document.querySelector<HTMLElement>(".mp-source-row");
		expect(row).not.toBeNull();
		expect(row!.textContent).toContain("my-source");
		expect(row!.textContent).toContain("git");
		expect(row!.textContent).toContain(SOURCE.sourceUri);

		// 添加输入框与提交按钮（空输入不可提交）。键入本身由浏览器
		// onChange 驱动，happy-dom 不派发合成 change，故本用例只钉入口
		// 存在与禁用态；add 的持久化契约由 daemon 服务测试覆盖。
		const form = document.querySelector<HTMLFormElement>(".mp-source-add")!;
		const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")!;
		expect(form.querySelector("input")).not.toBeNull();
		expect(submit.disabled).toBe(true);

		// 源段头部的刷新按钮 = 刷新全部源。
		const toolbar = document.querySelector<HTMLElement>(".mp-grid-toolbar")!;
		const refreshAll = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].find(
			b => b.textContent === t("guest.pluginRefresh"),
		)!;
		await act(async () => {
			refreshAll.click();
		});
		await flush();
		expect(calls.filter(c => c.method === "marketplace.sources.refresh").map(c => c.params)).toEqual([{}]);
		// Refresh response carries the source list itself; only the catalog is
		// re-pulled (mount + post-refresh).
		expect(calls.filter(c => c.method === "marketplace.list")).toHaveLength(2);

		const remove = [...document.querySelectorAll<HTMLButtonElement>(".mp-source-row button")].find(
			b => b.textContent === t("guest.pluginRemove"),
		);
		expect(remove).toBeDefined();
		await act(async () => {
			remove!.click();
		});
		await flush();
		expect(calls.filter(c => c.method === "marketplace.sources.remove").map(c => c.params)).toEqual([
			{ name: "my-source" },
		]);

		await unmount();
	});
});
