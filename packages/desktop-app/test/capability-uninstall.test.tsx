import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityCenter } from "../src/components/CapabilityCenter";
import { PromptProvider, useConfirm, usePrompt } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";

// 能力中心本地 skill 卸载回归（用户实机回归 2026-09-28，卸载对象是
// dev-expert）：
//   ① 卸载确认弹窗必须出现在模态带之上 —— 技能详情抽屉是 document.body
//      级 portal（z-3000 模态带），确认框曾 portal 进 #root：同带同 z 时
//      DOM 序定胜负，抽屉后挂载永远压在确认框上面，确认框不可见、点击被
//      抽屉全屏背板吞掉（"点卸载什么都没发生"）。
//   ② 确认框是紧凑确认样式 `gui-dialog--confirm`（380px auto 高），不是
//      基础 600×420 的 .gui-dialog。
//   ③ 点确认后真实发起 skills.delete({name}) 并重拉 skills.list —— 只把
//      名字移出批量选择集不会让已删卡片从网格消失。

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

// happy-dom 的 matchMedia 行为依赖版本；抽屉关闭路径要用它判
// prefers-reduced-motion，缺失时补一个恒 false 的最小实现。
if (typeof window.matchMedia !== "function") {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	})) as typeof window.matchMedia;
}

interface SkillRowShape {
	name: string;
	description: string;
	filePath: string;
	source: string;
	hide: boolean;
	content?: string;
	ignored: boolean;
	_source: { provider: string; providerName: string; path: string; level: "user" | "project" | "native" };
}

/** user 级本地文件技能（skills.install 装出来的形态）：可停用、可卸载。 */
const DEV_EXPERT: SkillRowShape = {
	name: "dev-expert",
	description: "P8 级编程助手",
	filePath: "C:\\skills\\dev-expert\\SKILL.md",
	source: "local",
	hide: false,
	// 虚拟技能才带 content；这里带上是为了让抽屉跳过 skills.read 回拉，
	// 测试聚焦卸载链本身。
	content: "# dev-expert\n",
	ignored: false,
	_source: { provider: "local", providerName: "本地", path: "C:\\skills\\dev-expert", level: "user" },
};

function makeRpc(): { rpc: RpcClient; requestSpy: ReturnType<typeof spyOn> } {
	const impl = {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			if (method === "skills.list") return { skills: [DEV_EXPERT], warnings: [] };
			if (method === "skills.delete") return { ok: true };
			throw new Error(`unexpected rpc: ${method} ${JSON.stringify(params)}`);
		},
	};
	const requestSpy = spyOn(impl, "request");
	return { rpc: impl as unknown as RpcClient, requestSpy };
}

/** 等 React 把 promise 链（RPC → setState）清空。 */
async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

/** 等真实定时器走过 n 毫秒（确认框/抽屉的 180ms 退出动画靠它推进）。 */
async function sleep(ms: number): Promise<void> {
	await act(async () => {
		await new Promise(r => setTimeout(r, ms));
	});
}

function callsOf(requestSpy: ReturnType<typeof spyOn>, method: string): unknown[] {
	return requestSpy.mock.calls.filter((c: unknown[]) => c[0] === method).map((c: unknown[]) => c[1]);
}

async function renderCenter(rpc: RpcClient): Promise<{ host: HTMLElement; unmount(): void }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(createElement(PromptProvider, null, createElement(CapabilityCenter, { rpc })));
	});
	await flush();
	return {
		host,
		unmount() {
			root.unmount();
			host.remove();
		},
	};
}

describe("能力中心卸载确认弹窗 — 层级与类名契约", () => {
	test("确认框是 body 直接子节点、带 gui-dialog--confirm、DOM 序在抽屉之后", async () => {
		const { rpc } = makeRpc();
		const { unmount } = await renderCenter(rpc);

		// 点开卡片 → 详情抽屉（body 级 portal）。
		const card = document.querySelector<HTMLElement>(".gui-cap-card");
		expect(card).not.toBeNull();
		await act(async () => {
			card!.click();
		});
		const drawerRoot = document.querySelector<HTMLElement>(".gui-cap-drawer-root");
		expect(drawerRoot).not.toBeNull();

		// 抽屉里点「卸载」→ 确认框出现。
		const deleteBtn = document.querySelector<HTMLElement>(".gui-cap-drawer-delete");
		expect(deleteBtn).not.toBeNull();
		await act(async () => {
			deleteBtn!.click();
		});

		const backdrop = document.querySelector<HTMLElement>(".gui-dialog-backdrop");
		expect(backdrop).not.toBeNull();
		// 层级契约：确认框直接挂 document.body（与 DialogFrame/抽屉同一
		// 层），同 z-3000 时由 DOM 序决定先后 —— 后打开的确认框必须排在
		// 先打开的抽屉之后，才能画在抽屉上面、收到点击。
		expect(backdrop!.parentElement).toBe(document.body);
		expect(drawerRoot!.compareDocumentPosition(backdrop!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// 紧凑确认样式契约：380px auto 高的 gui-dialog--confirm，不是基础
		// 600×420 的 .gui-dialog 裸框。
		const dialog = backdrop!.querySelector<HTMLElement>(".gui-dialog");
		expect(dialog!.classList.contains("gui-dialog--confirm")).toBe(true);
		expect(dialog!.classList.contains("gui-dialog--prompt")).toBe(false);

		unmount();
		backdrop!.remove();
	});

	test("点「取消」不发起卸载、抽屉保持打开", async () => {
		const { rpc, requestSpy } = makeRpc();
		const { unmount } = await renderCenter(rpc);
		await act(async () => {
			document.querySelector<HTMLElement>(".gui-cap-card")!.click();
		});
		await act(async () => {
			document.querySelector<HTMLElement>(".gui-cap-drawer-delete")!.click();
		});

		const cancelBtn = document.querySelector<HTMLElement>(".gui-dialog-backdrop .gui-btn:not(.gui-btn-primary)");
		expect(cancelBtn).not.toBeNull();
		await act(async () => {
			cancelBtn!.click();
		});
		await sleep(250); // 确认框 180ms 退出动画后才解析 promise

		expect(callsOf(requestSpy, "skills.delete")).toHaveLength(0);
		expect(document.querySelector(".gui-cap-drawer-root")).not.toBeNull();

		unmount();
		document.querySelector(".gui-dialog-backdrop")?.remove();
	});
});

describe("能力中心卸载 — 确认回调真实触发卸载 RPC 并刷新列表", () => {
	test("点「确定」→ skills.delete({name}) → 重拉 skills.list → 抽屉关闭", async () => {
		const { rpc, requestSpy } = makeRpc();
		const { unmount } = await renderCenter(rpc);
		await act(async () => {
			document.querySelector<HTMLElement>(".gui-cap-card")!.click();
		});
		await act(async () => {
			document.querySelector<HTMLElement>(".gui-cap-drawer-delete")!.click();
		});

		const okBtn = document.querySelector<HTMLElement>(".gui-dialog-backdrop .gui-btn-primary");
		expect(okBtn).not.toBeNull();
		await act(async () => {
			okBtn!.click();
		});
		await sleep(250); // 确认框 180ms 退出动画后才解析 promise

		// 真实断点回归：确认回调必须接上 skills.delete，参数按名删除。
		expect(callsOf(requestSpy, "skills.delete")).toEqual([{ name: "dev-expert" }]);

		await sleep(250); // 删除成功后抽屉 180ms 退出动画
		// 列表刷新契约：卸载成功后重拉 skills.list（挂载时 1 次 + 刷新 1 次）。
		expect(callsOf(requestSpy, "skills.list").length).toBeGreaterThanOrEqual(2);
		// 抽屉随卸载成功关闭。
		expect(document.querySelector(".gui-cap-drawer-root")).toBeNull();

		unmount();
	});
});

/** 探针：同时暴露 prompt/confirm 两个入口，锁定两种弹窗的类名分化。 */
function DialogProbe({ onPromptResult }: { onPromptResult(v: string | null): void }): ReactNode {
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	return createElement(
		"div",
		null,
		createElement("button", {
			className: "probe-prompt",
			onClick: () =>
				void prompt({ title: "输入名字" }).then(v => {
					onPromptResult(v);
				}),
		}),
		createElement("button", {
			className: "probe-confirm",
			onClick: () =>
				void confirm("确定吗？").then(v => {
					onPromptResult(String(v));
				}),
		}),
	);
}

describe("prompt-dialog — prompt 与 confirm 的样式分化契约", () => {
	test("prompt 弹窗保持 gui-dialog--prompt 且挂 document.body", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		let result: string | null = "unset";
		await act(async () => {
			root.render(
				createElement(PromptProvider, null, createElement(DialogProbe, { onPromptResult: v => (result = v) })),
			);
		});
		await act(async () => {
			document.querySelector<HTMLElement>(".probe-prompt")!.click();
		});
		const dialog = document.querySelector<HTMLElement>(".gui-dialog");
		expect(dialog).not.toBeNull();
		expect(dialog!.classList.contains("gui-dialog--prompt")).toBe(true);
		expect(dialog!.closest(".gui-dialog-backdrop")?.parentElement).toBe(document.body);

		// Escape 取消 → promise 解析 null（输入框自身的 Escape 处理）。
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		await sleep(250);
		expect(result).toBeNull();

		root.unmount();
		host.remove();
		document.querySelector(".gui-dialog-backdrop")?.remove();
	});
});
