import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SkillPreviewDialog } from "../src/components/SkillMarketView";
import type { RpcClient } from "../src/lib/rpc";

// 技能市场预览弹窗的描述渲染契约（用户实机回归 2026-09-27）：
// SkillHub 卡片点开预览——加载中可见搜索条目自带的描述，加载完成后描述
// 绝不能消失。detail 拉回更全的描述时优先 detail；detail 无描述时回落
// entry 描述；两者皆无才显示"暂不支持正文预览"。

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const ENTRY_DESC_ZH = "编程专家.Skill P8级编程助手，25年实战经验";
const DETAIL_DESC_ZH = "P8 级编程助手：全栈工程、代码审查、重构、测试用例";

interface PreviewCase {
	name: string;
	entryDescZh?: string;
	entryDesc?: string;
	detail: Record<string, unknown> | null;
	/** 加载完成后弹窗里必须仍包含的描述文本。 */
	expectDesc: string;
}

const cases: PreviewCase[] = [
	{
		name: "detail 无描述字段（真实 v1 报文形状）→ 回落 entry 描述",
		entryDescZh: ENTRY_DESC_ZH,
		detail: { slug: "dev-expert", latestVersion: "2.0.1", files: [{ path: "SKILL.md", size: 100 }] },
		expectDesc: ENTRY_DESC_ZH,
	},
	{
		name: "detail 带回更全的中文描述 → 优先 detail 描述",
		entryDescZh: ENTRY_DESC_ZH,
		detail: {
			slug: "dev-expert",
			latestVersion: "2.0.1",
			descriptionZh: DETAIL_DESC_ZH,
			files: [{ path: "SKILL.md", size: 100 }],
		},
		expectDesc: DETAIL_DESC_ZH,
	},
	{
		name: "英文条目只有 entry.description → 加载后仍在",
		entryDesc: "Find skills from the marketplace",
		detail: { slug: "find-skills", latestVersion: "1.0.0", files: [] },
		expectDesc: "Find skills from the marketplace",
	},
	{
		name: "entry 无描述 + detail 带回描述 → 加载后补上",
		detail: {
			slug: "dev-expert",
			latestVersion: "2.0.1",
			descriptionZh: DETAIL_DESC_ZH,
			files: [{ path: "SKILL.md", size: 100 }],
		},
		expectDesc: DETAIL_DESC_ZH,
	},
	{
		name: "entry 与 detail 同文 → 只渲染一段（不叠重复）",
		entryDescZh: ENTRY_DESC_ZH,
		detail: {
			slug: "dev-expert",
			latestVersion: "2.0.1",
			descriptionZh: ENTRY_DESC_ZH,
			files: [{ path: "SKILL.md", size: 100 }],
		},
		expectDesc: ENTRY_DESC_ZH,
	},
];

/** 统计一段描述文本在弹窗里出现的段落次数（重复渲染契约）。
 *  描述段用 `data-skill-summary` 标记，不绑具体样式类 —— 外观换壳不该动契约。 */
function descParagraphCount(host: HTMLElement, text: string): number {
	return Array.from(host.querySelectorAll("p[data-skill-summary]")).filter(p => p.textContent === text).length;
}

function makeRpc(detail: Record<string, unknown> | null): RpcClient {
	return {
		request: async (method: string) => {
			if (method === "skills.marketplace.preview") return { detail };
			throw new Error(`unexpected rpc: ${method}`);
		},
	} as unknown as RpcClient;
}

function entryOf(c: PreviewCase): {
	id: string;
	source: "skillhub";
	slug: string;
	name: string;
	description: string;
	descriptionZh?: string;
} {
	return {
		id: "skillhub:dev-expert",
		source: "skillhub",
		slug: "dev-expert",
		name: "编程专家.Skill",
		description: c.entryDesc ?? "",
		descriptionZh: c.entryDescZh,
	};
}

for (const c of cases) {
	describe(`SkillPreviewDialog 描述粘住 — ${c.name}`, () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);

		test("加载完成后描述仍渲染（不得比加载中信息少）", async () => {
			await act(async () => {
				root.render(
					createElement(SkillPreviewDialog, {
						rpc: makeRpc(c.detail),
						entry: entryOf(c),
						installed: false,
						busy: false,
						onInstall: () => {},
						onClose: () => {},
					}),
				);
			});
			// 等 preview RPC 的 promise 链走完（loading → loaded）。
			await act(async () => {
				await Promise.resolve();
			});
			// 抽屉 portal 到 document.body（视口锚定），断言从弹层本身取。
			const dialog = document.querySelector('[role="dialog"]');
			expect(dialog).not.toBeNull();
			expect(dialog?.textContent).not.toContain("正在加载预览");
			expect(dialog?.textContent).toContain(c.expectDesc);
			// 描述只渲染一处：detail 与 entry 同文时不得叠两段。
			expect(descParagraphCount(dialog as HTMLElement, c.expectDesc)).toBe(1);
			await act(async () => root.unmount());
			host.remove();
		});
	});
}

// 样式对齐契约：市场预览复用「我安装的」技能详情抽屉外壳（gui-cap-drawer*）。
// 另起一套平行弹窗就会漂成两种观感 —— 这条断言把外壳钉住。
describe("SkillPreviewDialog 外壳 = 技能详情抽屉", () => {
	test("挂载 gui-cap-drawer* 外壳并 portal 到 body", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				createElement(SkillPreviewDialog, {
					rpc: makeRpc({ latestVersion: "1.2.4", files: [{ path: "SKILL.md", size: 7953 }] }),
					entry: entryOf(cases[0]),
					installed: false,
					busy: false,
					onInstall: () => {},
					onClose: () => {},
				}),
			);
		});
		await act(async () => {
			await Promise.resolve();
		});
		const rootEl = document.querySelector(".gui-cap-drawer-root");
		expect(rootEl).not.toBeNull();
		// portal：抽屉不在挂载点里，而在 body 直下。
		expect(host.querySelector(".gui-cap-drawer-root")).toBeNull();
		expect(rootEl?.querySelector(".gui-cap-drawer-backdrop")).not.toBeNull();
		expect(rootEl?.querySelector(".gui-cap-drawer .gui-cap-drawer-head")).not.toBeNull();
		expect(rootEl?.querySelector(".gui-cap-drawer .gui-cap-drawer-actions")).not.toBeNull();
		expect(rootEl?.querySelectorAll(".gui-cap-drawer-tabs .gui-cap-drawer-tab").length).toBeGreaterThanOrEqual(2);
		expect(rootEl?.querySelector(".gui-cap-drawer-body")).not.toBeNull();
		await act(async () => root.unmount());
		host.remove();
	});
});
