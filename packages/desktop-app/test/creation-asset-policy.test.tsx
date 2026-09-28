import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
// @lobehub/icons has an internal cycle (brand module ↔ providerConfig); importing
// the package entry first initializes providerConfig before the brand modules
// that reference it, avoiding the TDZ crash under bun's module evaluation order.
import "@lobehub/icons";
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { type CreationMessage, resetCreationDraftCacheForTest } from "../src/components/CreationModeRow";
import { WelcomeComposer } from "../src/components/WelcomeComposer";
import type { RpcClient } from "../src/lib/rpc";

/**
 * M3.7c 素材策略 + 高级折叠契约（docs/review/0.5.0-m3-mode-page-redesign.md
 * §4 与 §6 3.7c 行）:
 *
 * 1. 素材策略单选默认 ai-image 且默认也落 metadata.assetPolicy（契约明确）;
 *    切色块占位 → metadata.assetPolicy="placeholder"（chip 两态逐字段断言）。
 * 2. 「高级 ▸」折叠区展开态入草稿缓存（sessionDraft）,切换类型 chip 不丢。
 * 3. 视频 chip 选中时折叠区内联媒体 provider 选择卡（media.providers RPC,
 *    video 条目 agnes/agnes-global）:点 agnes → metadata.media.provider/model
 *    随 session.create 管线走（provider 选择 → metadata 端到端契约）;
 *    未配置的 agnes-global 卡禁用。
 * 4. 折叠区内类型特有字段编辑随发送落 metadata（deck 演讲者备注 /
 *    prototype 平台多选）——M3.1 逐字段对表默认列之外的可编辑路径。
 * 5. template chip 的内容区是模板 rail,素材策略行整体不渲染。
 *
 * sessionDraft 是 CreationModeRow 模块级缓存,用例按序有意复用:
 * 「默认 ai-image」必须在任何素材策略点击之前跑。
 */

setLocale("zh-CN");
afterAll(() => {
	// bun test 同进程多文件共享模块级 sessionDraft——本文件有意复用草稿
	// 跨用例跑(见文件头),跑完归位,后面执行的 creation-mode-page.test.tsx
	// 才能从「应用刚启动」的默认态开始。
	resetCreationDraftCacheForTest();
	setLocale("en-US");
});

interface CapturedSubmit {
	metadata: Record<string, unknown>;
	message?: CreationMessage;
}

const captured: CapturedSubmit[] = [];

const VIDEO_PROVIDERS = {
	builtin: [
		{
			id: "agnes",
			label: "Agnes",
			kind: "video",
			source: "builtin",
			configured: true,
			description: "Requires AGNES_API_KEY",
			models: ["agnes-video-v2.0"],
		},
		{
			id: "agnes-global",
			label: "Agnes (Global)",
			kind: "video",
			source: "builtin",
			configured: false,
			description: "Requires AGNES_GLOBAL_API_KEY",
			models: ["agnes-video-v2.0-global"],
		},
	],
	extension: [],
};

/** 欢迎页 composer + 模式页依赖的 daemon 通道桩:模板列表 / 镜像回填 /
 *  设计体系列表 / 媒体 provider 列表（3.7c 数据源）。 */
function makeRpc(mediaProviders?: unknown): RpcClient {
	return {
		request: (method: string): Promise<unknown> => {
			if (method === "creation.templates.list") return Promise.resolve({ templates: [] });
			if (method === "creation.metadata.get") return Promise.resolve({ metadata: null });
			if (method === "design.systems.list") return Promise.resolve({ systems: [] });
			if (method === "media.providers") return Promise.resolve(mediaProviders ?? {});
			if (method === "git.branches") return Promise.resolve({ current: null, branches: [] });
			if (method === "models.listAvailable" || method === "models.list") return Promise.resolve([]);
			return Promise.resolve({});
		},
		// ModelSelector 订阅 models.changed 刷新目录;测试桩无需投递事件。
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

function renderWelcome(rpc: RpcClient): ReturnType<typeof createRoot> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => {
		root.render(
			createElement(WelcomeComposer, {
				rpc,
				project: "C:\\proj",
				modes: [
					{ id: "work", label: "Work" },
					{ id: "design", label: "Design" },
				],
				modeId: "design",
				onModeChange: () => {},
				designSubmit: (metadata: Record<string, unknown>, message?: CreationMessage) => {
					captured.push({ metadata, message });
					return Promise.resolve(true);
				},
				onSubmit: () => {},
			}),
		);
	});
	return root;
}

/** 等模式页的派生态 effect（placeholder 上报/句柄注册/provider 回填）落地。 */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(r => setTimeout(r, 30));
	});
}

function chipButton(label: string): HTMLButtonElement {
	const btn = [...document.body.querySelectorAll<HTMLButtonElement>(".gui-creation-chip")].find(
		b => b.textContent === label,
	);
	expect(btn).toBeDefined();
	return btn!;
}

function advancedToggle(): HTMLButtonElement {
	const btn = document.body.querySelector<HTMLButtonElement>(".gui-creation-advanced-toggle");
	expect(btn).not.toBeNull();
	return btn!;
}

/** sessionDraft 跨用例复用（有意）:展开态不预设,按需点开。 */
function ensureAdvancedOpen(): void {
	if (advancedToggle().getAttribute("aria-expanded") !== "true") {
		act(() => {
			advancedToggle().click();
		});
	}
	expect(advancedToggle().getAttribute("aria-expanded")).toBe("true");
}

/**
 * 模拟输入 + 发送（与 creation-mode-page.test.tsx 同款驱动:happy-dom 下
 * React 19 合成 input 事件进不了 ChangeEventPlugin,直接调 textarea 自身
 * props 的 onChange,再原生点击发送按钮）。
 */
async function typeAndSend(text: string): Promise<void> {
	const textarea = document.body.querySelector("textarea");
	expect(textarea).not.toBeNull();
	const propsKey = Object.keys(textarea!).find(k => k.startsWith("__reactProps$"))!;
	const props = (textarea as unknown as Record<string, { onChange(e: unknown): void }>)[propsKey]!;
	(textarea as HTMLTextAreaElement).value = text;
	act(() => {
		props.onChange({ target: textarea, currentTarget: textarea });
	});
	const sendBtn = document.body.querySelector<HTMLButtonElement>(".gui-send-btn");
	expect(sendBtn).not.toBeNull();
	act(() => {
		sendBtn!.click();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

describe("M3.7c 素材策略行 + 高级折叠", () => {
	test("素材策略默认 ai-image,默认也落 metadata.assetPolicy;行在 composer 下方、设计体系 rail 之下", async () => {
		captured.length = 0;
		const root = renderWelcome(makeRpc());
		await settle();
		// 行存在,默认选中 AI 生图（radio 契约）。
		const row = document.body.querySelector("[data-testid='gui-creation-assetrow']")!;
		expect(row).not.toBeNull();
		const aiRadio = row.querySelector<HTMLButtonElement>("[data-asset-policy='ai-image']")!;
		expect(aiRadio.getAttribute("aria-checked")).toBe("true");
		expect(
			row.querySelector<HTMLButtonElement>("[data-asset-policy='placeholder']")!.getAttribute("aria-checked"),
		).toBe("false");
		// 信息架构位置（§2.2:composer 下方 → 设计体系 rail → 素材策略行）。
		const form = document.body.querySelector(".gui-welcome-form")!;
		const dsRail = document.body.querySelector("[data-testid='gui-design-system-rail']")!;
		expect(form.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(dsRail.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await typeAndSend("画一个落地页");
		expect(captured).toHaveLength(1);
		// 默认也落键——契约明确（daemon 值域校验以键存在为前提）。
		expect(captured[0]!.metadata.assetPolicy).toBe("ai-image");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("切色块占位 → metadata.assetPolicy='placeholder'", async () => {
		captured.length = 0;
		const root = renderWelcome(makeRpc());
		await settle();
		act(() => {
			document.body.querySelector<HTMLButtonElement>("[data-asset-policy='placeholder']")!.click();
		});
		await typeAndSend("画一个落地页");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.assetPolicy).toBe("placeholder");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("「高级 ▸」展开态切 chip 不丢（草稿缓存）", async () => {
		const root = renderWelcome(makeRpc());
		await settle();
		expect(advancedToggle().getAttribute("aria-expanded")).toBe("false");
		act(() => {
			advancedToggle().click();
		});
		expect(advancedToggle().getAttribute("aria-expanded")).toBe("true");
		// 依次切媒体/演示稿/原型 chip,展开态保持。
		for (const label of [t("creation media video"), t("creation tab deck"), t("creation tab prototype")]) {
			act(() => {
				chipButton(label).click();
			});
			expect(advancedToggle().getAttribute("aria-expanded")).toBe("true");
		}
		root.unmount();
		document.body.innerHTML = "";
	});

	test("deck 演讲者备注 / prototype 平台多选:高级字段编辑随发送落 metadata", async () => {
		captured.length = 0;
		const root = renderWelcome(makeRpc());
		await settle();
		// deck:打开高级,点演讲者备注 toggle。
		act(() => {
			chipButton(t("creation tab deck")).click();
		});
		ensureAdvancedOpen();
		act(() => {
			chipButton(t("creation speaker notes")).click();
		});
		await typeAndSend("做一份演示稿");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.kind).toBe("deck");
		expect(captured[0]!.metadata.speakerNotes).toBe(true);
		expect(captured[0]!.metadata.assetPolicy).toBe("placeholder"); // 上一用例的缓存态,随键走
		root.unmount();
		document.body.innerHTML = "";

		captured.length = 0;
		const root2 = renderWelcome(makeRpc());
		await settle();
		// prototype:平台多选加 iOS（默认 responsive 之上追加）。草稿缓存的
		// 选中 chip 是上一段的 deck——先点回 prototype,平台字段才出现。
		act(() => {
			chipButton(t("creation tab prototype")).click();
		});
		ensureAdvancedOpen();
		act(() => {
			chipButton(t("creation platform mobile-ios")).click();
		});
		await typeAndSend("画一个落地页");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.platforms).toEqual(["responsive", "mobile-ios"]);
		root2.unmount();
		document.body.innerHTML = "";
	});

	test("视频 chip 内联 provider 卡:选 agnes → metadata.media.provider/model 端到端落 metadata", async () => {
		captured.length = 0;
		const root = renderWelcome(makeRpc(VIDEO_PROVIDERS));
		await settle();
		act(() => {
			chipButton(t("creation media video")).click();
		});
		await settle(); // media.providers 回填 + 已配置优先自动选中
		ensureAdvancedOpen();
		const agnes = document.body.querySelector<HTMLButtonElement>("[data-media-provider='agnes']");
		const agnesGlobal = document.body.querySelector<HTMLButtonElement>("[data-media-provider='agnes-global']");
		expect(agnes).not.toBeNull();
		expect(agnesGlobal).not.toBeNull();
		// 未配置 provider 禁用（M3.2 同款置灰语义）。
		expect(agnesGlobal!.disabled).toBe(true);
		expect(agnes!.disabled).toBe(false);
		act(() => {
			agnes!.click();
		});
		await typeAndSend("拍一支产品宣传片");
		expect(captured).toHaveLength(1);
		const metadata = captured[0]!.metadata;
		expect(metadata.kind).toBe("media");
		// provider 选择 → media 分支 → session.create 管线（端到端契约）。
		const media = metadata.media as { kind: string; provider: string; model: string };
		expect(media.kind).toBe("video");
		expect(media.provider).toBe("agnes");
		expect(media.model).toBe("agnes-video-v2.0");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("template chip 的内容区是模板 rail,素材策略行不渲染", async () => {
		const root = renderWelcome(makeRpc());
		await settle();
		act(() => {
			chipButton(t("creation tab template")).click();
		});
		await settle();
		expect(document.body.querySelector("[data-testid='gui-creation-assetrow']")).toBeNull();
		// 切回非 template chip,行恢复（portal 随 chip 派生）。
		act(() => {
			chipButton(t("creation tab prototype")).click();
		});
		expect(document.body.querySelector("[data-testid='gui-creation-assetrow']")).not.toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});
});
