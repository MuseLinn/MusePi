import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
// @lobehub/icons has an internal cycle (brand module ↔ providerConfig); importing
// the package entry first initializes providerConfig before the brand modules
// that reference it, avoiding the TDZ crash under bun's module evaluation order.
import "@lobehub/icons";
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale, type TranslationKey, t } from "@musepi/client-core";
import { creation as creationZh } from "@musepi/client-core/src/i18n/zh-CN/creation.js";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CreationMessage } from "../src/components/CreationModeRow";
import { WelcomeComposer } from "../src/components/WelcomeComposer";
import { applyChip, buildProjectMetadata, type CREATION_CHIPS, DEFAULT_CREATION_DRAFT } from "../src/lib/creation";
import type { RpcClient } from "../src/lib/rpc";

/**
 * M3.7a 模式页骨架契约——欢迎页内联形态(v2 修订,
 * docs/review/0.5.0-m3-mode-page-redesign.md §6 3.7a 行):
 *
 * 1. chip 排单选、默认 prototype,选中 chip 即把 kind/intent 写进草稿 ——
 *    每个 chip 经欢迎页 composer 发送产出的 projectMetadata 与 M3.2 编译
 *    管线(buildProjectMetadata,逐字段)一致(六类 chip 均可建会话)。
 * 2. 发送 = designSubmit(metadata, message):metadata 走既有编译管线,
 *    message 携带首轮文本;没有弹层、没有第二个输入框——用的就是欢迎页
 *    composer 本体。
 * 3. Escape 收起 chip 排(mode chip 复位 work)。
 * 4. 草稿跨再入保留:卸载重挂后 chip 选择仍在。
 * 5. 「项目名」「工作目录」字段退役:DOM 无底栏,creation 词表无对应键
 *    (字段若复活,两处任一都会重新出现)。
 *
 * sessionDraft 是 CreationModeRow 模块级缓存,测试间有意按序复用:
 * 「默认 prototype」必须在任何 chip 切换之前跑。
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

interface CapturedSubmit {
	metadata: Record<string, unknown>;
	message?: CreationMessage;
}

const captured: CapturedSubmit[] = [];
const modeChanges: (string | null)[] = [];

/** 欢迎页 composer + 模式页唯一依赖的 daemon 通道:模板列表 + 镜像回填 +
 *  欢迎页自身的就绪态/模型目录/git 分支等。 */
function makeRpc(templates: unknown[] = []): RpcClient {
	return {
		request: (method: string): Promise<unknown> => {
			if (method === "creation.templates.list") return Promise.resolve({ templates });
			if (method === "creation.metadata.get") return Promise.resolve({ metadata: null });
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
				onModeChange: (id: string | null) => {
					modeChanges.push(id);
				},
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

/** 等模式页的派生态 effect(placeholder 上报/模板回填/句柄注册)落地。 */
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

function onChip(el: HTMLButtonElement): boolean {
	return el.classList.contains("gui-creation-chip--on");
}

/**
 * 模拟输入 + 发送。happy-dom 下 React 19 的合成 input/keydown 事件进不了
 * ChangeEventPlugin(插件内部崩溃、onChange 不触发),所以改为直接驱动
 * textarea 自身 props 里的 onChange(等价于用户键入),再原生点击发送
 * 按钮(chip/模板的 .click() 在本环境已被验证可靠)。
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

describe("M3.7a 模式页 chip 排(欢迎页内联形态)", () => {
	test("默认选中 prototype,placeholder 随 chip 变化", async () => {
		const root = renderWelcome(makeRpc());
		await settle();
		expect(onChip(chipButton(t("creation tab prototype")))).toBe(true);
		expect(onChip(chipButton(t("creation tab other")))).toBe(false);
		const textarea = document.body.querySelector("textarea")!;
		expect(textarea.placeholder).toBe(t("creation placeholder prototype"));
		act(() => {
			chipButton(t("creation media video")).click();
		});
		expect(textarea.placeholder).toBe(t("creation placeholder video"));
		root.unmount();
		document.body.innerHTML = "";
	});

	test("六类 chip 均可建会话,metadata 与 M3.2 编译管线逐字段一致", async () => {
		const cases: { chip: (typeof CREATION_CHIPS)[number]; label: TranslationKey }[] = [
			{ chip: "prototype", label: "creation tab prototype" },
			{ chip: "live-artifact", label: "creation tab live artifact" },
			{ chip: "deck", label: "creation tab deck" },
			{ chip: "image", label: "creation media image" },
			{ chip: "video", label: "creation media video" },
			{ chip: "audio", label: "creation media audio" },
			{ chip: "other", label: "creation tab other" },
		];
		for (const { chip, label } of cases) {
			captured.length = 0;
			const root = renderWelcome(makeRpc());
			await settle();
			act(() => {
				chipButton(t(label)).click();
			});
			await typeAndSend(`用 ${chip} 做一件事`);
			expect(captured).toHaveLength(1);
			const { metadata, message } = captured[0]!;
			// 发送契约:首轮文本原样随消息走,metadata 由既有编译管线产出。
			expect(message?.text).toBe(`用 ${chip} 做一件事`);
			// chip → 草稿 → metadata:与 M3.2 的 buildProjectMetadata 逐字段一致
			// (时间戳归一后全等,字段路由漂移即红)。
			const expected = buildProjectMetadata(applyChip(DEFAULT_CREATION_DRAFT, chip));
			expect({ ...metadata, createdAt: 0, updatedAt: 0 }).toEqual({ ...expected, createdAt: 0, updatedAt: 0 });
			// 每个 chip 的 kind/intent 判别字段(回归六面分类法语义)。
			if (chip === "live-artifact") {
				expect(metadata.kind).toBe("prototype");
				expect(metadata.intent).toBe("live-artifact");
			} else if (chip === "image" || chip === "video" || chip === "audio") {
				expect(metadata.kind).toBe("media");
				expect((metadata.media as { kind: string }).kind).toBe(chip);
			} else {
				expect(metadata.kind).toBe(chip);
			}
			root.unmount();
			document.body.innerHTML = "";
		}
	});

	test("template chip 收起输入框内联展开模板 rail,点行即以模板快照建会话", async () => {
		const tpl = {
			id: "tpl-1",
			name: "我的演示稿",
			tab: "deck",
			metadata: { version: 1, kind: "deck", speakerNotes: true },
			createdAt: "2026-09-27T00:00:00Z",
			updatedAt: "2026-09-27T00:00:00Z",
		};
		captured.length = 0;
		const root = renderWelcome(makeRpc([tpl]));
		await settle();
		act(() => {
			chipButton(t("creation tab template")).click();
		});
		await settle(); // 等模板列表 RPC 回填并渲染 rail
		// template chip 收起输入框,模板 rail 内联落在 chip 排下方(§2.3)。
		expect(document.body.querySelector("textarea")).toBeNull();
		const row = document.body.querySelector<HTMLButtonElement>(".gui-creation-template-main");
		expect(row).not.toBeNull();
		expect(row!.textContent).toContain("我的演示稿");
		await act(async () => {
			row!.click();
			await Promise.resolve();
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.templateId).toBe("tpl-1");
		expect(captured[0]!.metadata.kind).toBe("deck");
		root.unmount();
		document.body.innerHTML = "";
	});
});

describe("M3.7a 模式页骨架契约", () => {
	test("Escape 收起 chip 排(mode chip 复位 work)", async () => {
		const root = renderWelcome(makeRpc());
		await settle();
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await Promise.resolve();
		});
		expect(modeChanges).toContain("work");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("chip 选择跨再入保留(草稿模块级缓存)", async () => {
		// 模块级 sessionDraft 已被前面的用例写过 —— 本次显式切到 deck 再卸载,
		// 重挂即验证回填而不是默认值。
		const root = renderWelcome(makeRpc());
		await settle();
		act(() => {
			chipButton(t("creation tab deck")).click();
		});
		expect(onChip(chipButton(t("creation tab deck")))).toBe(true);
		root.unmount();
		document.body.innerHTML = "";
		const root2 = renderWelcome(makeRpc());
		await settle();
		expect(onChip(chipButton(t("creation tab deck")))).toBe(true);
		root2.unmount();
		document.body.innerHTML = "";
	});

	test("「项目名」「工作目录」字段随底栏退役;无弹层无第二输入框", async () => {
		const root = renderWelcome(makeRpc());
		await settle();
		// DOM 侧:无底栏、无项目名输入框(复活即红)。
		expect(document.body.querySelector(".gui-creation-foot")).toBeNull();
		expect(document.body.querySelector("#gui-creation-name")).toBeNull();
		// v2 内联形态:无居中弹层残留(backdrop/panel 复活即红),输入框
		// 只有一个(欢迎页 composer 本体)。
		expect(document.body.querySelector(".gui-creation-backdrop")).toBeNull();
		expect(document.body.querySelector(".gui-creation-panel")).toBeNull();
		expect(document.body.querySelectorAll("textarea")).toHaveLength(1);
		// 词表侧:creation 域不再持有这两个字段的键。
		expect("creation project name" in creationZh).toBe(false);
		expect("creation workspace" in creationZh).toBe(false);
		root.unmount();
		document.body.innerHTML = "";
	});
});
