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
import { type CreationMessage, CreationPanel } from "../src/components/CreationPanel";
import { applyChip, buildProjectMetadata, type CREATION_CHIPS, DEFAULT_CREATION_DRAFT } from "../src/lib/creation";
import type { RpcClient } from "../src/lib/rpc";

/**
 * M3.7a 模式页骨架契约（docs/review/0.5.0-m3-mode-page-redesign.md §6 3.7a 行）：
 *
 * 1. chip 排单选、默认 prototype，选中 chip 即把 kind/intent 写进草稿 ——
 *    每个 chip 经面板发送产出的 projectMetadata 与 M3.2 编译管线
 *    （buildProjectMetadata，逐字段）一致（六类 chip 均可建会话）。
 * 2. 输入框发送 = 面板 onSubmit(metadata, message)：metadata 走既有
 *    编译管线，message 携带首轮文本。
 * 3. Escape 收合面板（capture 阶段 onClose）。
 * 4. 草稿跨再入保留：卸载重挂后 chip 选择仍在。
 * 5. 「项目名」「工作目录」字段退役：DOM 无底栏，creation 词表无对应键
 *    （字段若复活，两处任一都会重新出现）。
 *
 * sessionDraft 是 CreationPanel 模块级缓存，测试间有意按序复用：
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
let closeCount = 0;

/** 面板唯一依赖的 daemon 通道:模板列表 + 镜像回填。 */
function makeRpc(templates: unknown[] = []): RpcClient {
	return {
		request: (method: string): Promise<unknown> => {
			if (method === "creation.templates.list") return Promise.resolve({ templates });
			if (method === "creation.metadata.get") return Promise.resolve({ metadata: null });
			if (method === "models.listAvailable" || method === "models.list") return Promise.resolve([]);
			return Promise.resolve({});
		},
		// ModelSelector 订阅 models.changed 刷新目录;测试桩无需投递事件。
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

function renderPanel(rpc: RpcClient): ReturnType<typeof createRoot> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => {
		root.render(
			createElement(CreationPanel, {
				open: true,
				onClose: () => {
					closeCount++;
				},
				rpc,
				project: "C:\\proj",
				onSubmit: (metadata: Record<string, unknown>, message?: CreationMessage) => {
					captured.push({ metadata, message });
					return Promise.resolve(true);
				},
			}),
		);
	});
	return root;
}

/** 等两相位进场的双 rAF 把 phase 推进到 open（Escape 监听此时才生效）。 */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(r => setTimeout(r, 30));
	});
}

function panelEl(): HTMLElement {
	const el = document.body.querySelector<HTMLElement>(".gui-creation-panel");
	expect(el).not.toBeNull();
	return el!;
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
	const textarea = panelEl().querySelector("textarea");
	expect(textarea).not.toBeNull();
	const propsKey = Object.keys(textarea!).find(k => k.startsWith("__reactProps$"))!;
	const props = (textarea as unknown as Record<string, { onChange(e: unknown): void }>)[propsKey]!;
	(textarea as HTMLTextAreaElement).value = text;
	act(() => {
		props.onChange({ target: textarea, currentTarget: textarea });
	});
	const sendBtn = panelEl().querySelector<HTMLButtonElement>(".gui-send-btn");
	expect(sendBtn).not.toBeNull();
	act(() => {
		sendBtn!.click();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

describe("M3.7a 模式页 chip 排", () => {
	test("默认选中 prototype，placeholder 随 chip 变化", async () => {
		const root = renderPanel(makeRpc());
		await settle();
		expect(onChip(chipButton(t("creation tab prototype")))).toBe(true);
		expect(onChip(chipButton(t("creation tab other")))).toBe(false);
		const textarea = panelEl().querySelector("textarea")!;
		expect(textarea.placeholder).toBe(t("creation placeholder prototype"));
		act(() => {
			chipButton(t("creation media video")).click();
		});
		expect(textarea.placeholder).toBe(t("creation placeholder video"));
		root.unmount();
		document.body.innerHTML = "";
	});

	test("六类 chip 均可建会话，metadata 与 M3.2 编译管线逐字段一致", async () => {
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
			const root = renderPanel(makeRpc());
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

	test("template chip 的内容区是模板 rail，点行即以模板快照建会话", async () => {
		const tpl = {
			id: "tpl-1",
			name: "我的演示稿",
			tab: "deck",
			metadata: { version: 1, kind: "deck", speakerNotes: true },
			createdAt: "2026-09-27T00:00:00Z",
			updatedAt: "2026-09-27T00:00:00Z",
		};
		captured.length = 0;
		const root = renderPanel(makeRpc([tpl]));
		await settle();
		act(() => {
			chipButton(t("creation tab template")).click();
		});
		await settle(); // 等模板列表 RPC 回填并渲染 rail
		// template chip 不渲染输入框,内容区 = 模板 rail(§2.3)。
		expect(panelEl().querySelector("textarea")).toBeNull();
		const row = panelEl().querySelector<HTMLButtonElement>(".gui-creation-template-main");
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
	test("Escape 收合面板", async () => {
		const before = closeCount;
		const root = renderPanel(makeRpc());
		await settle();
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await Promise.resolve();
		});
		expect(closeCount).toBe(before + 1);
		root.unmount();
		document.body.innerHTML = "";
	});

	test("chip 选择跨再入保留(草稿模块级缓存)", async () => {
		// 模块级 sessionDraft 已被前面的用例写过 —— 本次显式切到 deck 再卸载,
		// 重挂即验证回填而不是默认值。
		const root = renderPanel(makeRpc());
		await settle();
		act(() => {
			chipButton(t("creation tab deck")).click();
		});
		expect(onChip(chipButton(t("creation tab deck")))).toBe(true);
		root.unmount();
		document.body.innerHTML = "";
		const root2 = renderPanel(makeRpc());
		await settle();
		expect(onChip(chipButton(t("creation tab deck")))).toBe(true);
		root2.unmount();
		document.body.innerHTML = "";
	});

	test("「项目名」「工作目录」字段随底栏退役", async () => {
		const root = renderPanel(makeRpc());
		await settle();
		// DOM 侧:无底栏、无项目名输入框(复活即红)。
		expect(panelEl().querySelector(".gui-creation-foot")).toBeNull();
		expect(panelEl().querySelector("#gui-creation-name")).toBeNull();
		// 词表侧:creation 域不再持有这两个字段的键。
		expect("creation project name" in creationZh).toBe(false);
		expect("creation workspace" in creationZh).toBe(false);
		root.unmount();
		document.body.innerHTML = "";
	});
});
