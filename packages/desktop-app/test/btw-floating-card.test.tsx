import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BtwFloatingCard } from "../src/components/BtwFloatingCard";

// /btw 悬浮卡定位契约（用户实机回归 2026-09-27）：卡片在消息流中部飘出、
// 盖住会话内容。根因是 ChatView 面板上存在 transform/filter 祖先（进场动画，
// 被节流窗口会冻结在其中），position: fixed 被劫持到错误参照盒。契约：
// 无论 React 父级挂在哪个祖先下，卡片都必须 portal 到 document.body 直下，
// 保持右下锚定 + 视口高度上限（超长内部滚动），且首轮问答渲染一次不重复。

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const QUESTION = "你现在处于什么模式下?";
const ANSWER = "当前处于默认模式。";

describe("BtwFloatingCard 定位与渲染契约", () => {
	const host = document.createElement("div");
	// 模拟被冻结的进场动画祖先：transform/filter 任一存在都会把
	// fixed 参照盒从视口改到该祖先（gui-implementation §弹层规范）。
	host.style.transform = "scale(0.97)";
	host.style.filter = "blur(10px)";
	document.body.appendChild(host);
	const root = createRoot(host);

	test("卡片 portal 到 document.body，右下锚定且带视口高度上限", async () => {
		await act(async () => {
			root.render(
				createElement(BtwFloatingCard, {
					initialQuestion: QUESTION,
					onAsk: () => Promise.resolve({ replyText: ANSWER }),
					onClose: () => {},
				}),
			);
		});
		await act(async () => {
			await Promise.resolve();
		});
		const card = document.body.querySelector<HTMLElement>(".gui-btw-card");
		expect(card).not.toBeNull();
		// 逃出 transform/filter 链：fixed 参照盒回到视口，不再飘到消息流中部。
		expect(host.contains(card)).toBe(false);
		expect(document.body.contains(card)).toBe(true);
		// 锚定契约：右下贴底（输入框上方），任何窗口状态下不盖消息区中部。
		expect(card!.style.position).toBe("fixed");
		expect(card!.style.bottom).toBe("96px");
		expect(card!.style.right).toBe("24px");
		// 高度上限：超出内部滚动，不会顶到屏幕上半部。
		expect(card!.style.maxHeight).toContain("100dvh");
		root.unmount();
		host.remove();
	});

	test("首轮问答渲染一次：问题出现一次，答案回来后贴在问题下", async () => {
		const host2 = document.createElement("div");
		document.body.appendChild(host2);
		const root2 = createRoot(host2);
		await act(async () => {
			root2.render(
				createElement(BtwFloatingCard, {
					initialQuestion: QUESTION,
					onAsk: () => Promise.resolve({ replyText: ANSWER }),
					onClose: () => {},
				}),
			);
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const card = document.body.querySelector<HTMLElement>(".gui-btw-card")!;
		// 问题只渲染一次（重复渲染会强化"消息被顶走"的误判）。
		expect(Array.from(card.querySelectorAll(".gui-btw-q")).filter(q => q.textContent === QUESTION)).toHaveLength(1);
		// 答案渲染在问题之后（同轮内）。
		expect(card.textContent).toContain(ANSWER);
		const q = card.querySelector(".gui-btw-q")!;
		expect(card.textContent!.indexOf(ANSWER)).toBeGreaterThan(card.textContent!.indexOf(q.textContent ?? ""));
		root2.unmount();
		host2.remove();
	});
});
