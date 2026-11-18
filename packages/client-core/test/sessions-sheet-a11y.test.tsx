import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionsSheet } from "../src/components/shell/SessionsSheet";
import { t } from "../src/i18n/index.js";
import type { SessionClient } from "../src/lib/client";

// 会话行的状态语义与滑动动作的焦点可达性都要靠真实渲染 + CSS 规则一起验证：
// 前者只有挂载后才有可访问名称，后者 bun 没有 CSS 引擎。
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

/** 注释里会提到旧行为，不能让注释满足断言。 */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const SHELL_CSS = stripComments(
	fs.readFileSync(path.resolve(import.meta.dir, "../src/components/shell/shell.css"), "utf8"),
);

/** 某选择器 `:focus-visible` 规则的声明块；shell.css 无嵌套规则，正则足够。 */
function focusVisibleBody(selector: string): string | null {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`[^{}]*${escaped}:focus-visible[^{}]*\\{([^{}]*)\\}`).exec(SHELL_CSS);
	return match?.[1] ?? null;
}

/**
 * 简化的可访问名称拼接：`aria-label` 覆盖自身内容，`aria-hidden` 子树整体跳过。
 * 状态图标若真被读屏忽略，这里就拿不到它的名字。
 */
function accessibleText(root: Element): string {
	const parts: string[] = [];
	const walk = (node: Element): void => {
		if (node.getAttribute("aria-hidden") === "true") return;
		const label = node.getAttribute("aria-label");
		if (label !== null) {
			parts.push(label);
			return;
		}
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent ?? "");
			else if (child instanceof Element) walk(child);
		}
	};
	walk(root);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

function occurrences(haystack: string, needle: string): number {
	return needle.length === 0 ? 0 : haystack.split(needle).length - 1;
}

function makeSession(overrides: Partial<WorkspaceSessionInfo> & { id: string }): WorkspaceSessionInfo {
	return {
		title: overrides.id,
		cwd: "/work",
		messageCount: 1,
		working: false,
		paused: false,
		live: true,
		updatedAt: 1_751_791_200_000,
		...overrides,
	};
}

/** 最小 SessionClient 替身 —— 会话行只会调用 `rpc`。 */
function fakeClient(): SessionClient {
	return { rpc: async () => ({ ok: true }) } as unknown as SessionClient;
}

interface MountedSheet {
	rows(): HTMLButtonElement[];
	unmount(): Promise<void>;
}

async function mountSheet(sessions: readonly WorkspaceSessionInfo[], currentId: string | null): Promise<MountedSheet> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<SessionsSheet
				client={fakeClient()}
				sessions={sessions}
				currentId={currentId}
				onSelect={() => {}}
				open
				onClose={() => {}}
			/>,
		);
	});
	return {
		rows: () => [...document.querySelectorAll<HTMLButtonElement>(".ss-item")],
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/** 左滑越过半程，松开后行停在展开位（SWIPE_ACTIONS_PX）。 */
async function revealSwipeActions(row: HTMLButtonElement): Promise<void> {
	const at = (type: string, clientX: number): PointerEvent =>
		new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 20, pointerId: 1, button: 0 });
	await act(async () => row.dispatchEvent(at("pointerdown", 300)));
	await act(async () => row.dispatchEvent(at("pointermove", 180)));
	await act(async () => row.dispatchEvent(at("pointerup", 180)));
}

describe("滑动动作在键盘聚焦时可见", () => {
	for (const selector of [".ss-swipe-btn", ".ss-swipe-btn--delete", ".ss-swipe-btn--confirm", ".ss-rename-input"]) {
		it(`${selector} 的 :focus-visible 画出 --ring 焦点环`, () => {
			const body = focusVisibleBody(selector);
			expect(body, `${selector} 没有 :focus-visible 规则`).not.toBeNull();
			expect(body).toContain("outline");
			expect(body).toContain("var(--ring)");
		});
	}

	it("展开后动作按钮进入 tab 序并接得住焦点", async () => {
		const sheet = await mountSheet([makeSession({ id: "solo", title: "Only session" })], "solo");
		try {
			const row = sheet.rows()[0];
			if (!row) throw new Error("session row did not render");
			await revealSwipeActions(row);

			const actions = document.querySelector<HTMLElement>(".ss-swipe-actions");
			if (!actions) throw new Error("swipe actions did not render");
			expect(actions.getAttribute("aria-hidden")).not.toBe("true");
			expect(actions.inert).toBe(false);

			const buttons = [...actions.querySelectorAll<HTMLButtonElement>("button")];
			expect(buttons).toHaveLength(2);
			for (const button of buttons) expect(button.tabIndex).toBe(0);

			const target = buttons[0];
			if (!target) throw new Error("rename action did not render");
			await act(async () => target.focus());
			expect(document.activeElement).toBe(target);
		} finally {
			await sheet.unmount();
		}
	});
});

describe("会话行的运行/暂停状态对读屏可读", () => {
	it("运行中的行念出运行状态，且只念一次", async () => {
		const sheet = await mountSheet([makeSession({ id: "w", title: "Alpha", working: true })], "w");
		try {
			const row = sheet.rows()[0];
			if (!row) throw new Error("session row did not render");
			const text = accessibleText(row);
			expect(text).toContain("Alpha");
			const label = t("shell.sessionWorking");
			expect(text).toContain(label);
			// 图标与容器各念一次会让读屏重复播报同一个状态。
			expect(occurrences(text, label)).toBe(1);
		} finally {
			await sheet.unmount();
		}
	});

	it("暂停的行念出暂停状态，且只念一次", async () => {
		const sheet = await mountSheet([makeSession({ id: "p", title: "Beta", paused: true })], "p");
		try {
			const row = sheet.rows()[0];
			if (!row) throw new Error("session row did not render");
			const text = accessibleText(row);
			expect(text).toContain("Beta");
			const label = t("shell.sessionPaused");
			expect(text).toContain(label);
			expect(occurrences(text, label)).toBe(1);
		} finally {
			await sheet.unmount();
		}
	});

	it("没有运行也没有暂停的行不播报状态", async () => {
		// 空闲行是列表里的大多数；每行都念一句状态会把标题淹没。
		const sheet = await mountSheet([makeSession({ id: "i", title: "Idle one" })], "i");
		try {
			const row = sheet.rows()[0];
			if (!row) throw new Error("session row did not render");
			const text = accessibleText(row);
			expect(text).toContain("Idle one");
			expect(text).not.toContain(t("shell.sessionWorking"));
			expect(text).not.toContain(t("shell.sessionPaused"));
		} finally {
			await sheet.unmount();
		}
	});
});

describe("当前会话行标出 aria-current", () => {
	it("只有当前会话行带 aria-current，其余行为空", async () => {
		const sheet = await mountSheet(
			[makeSession({ id: "a", title: "Alpha" }), makeSession({ id: "b", title: "Beta" })],
			"b",
		);
		try {
			const [alpha, beta] = sheet.rows();
			if (!alpha || !beta) throw new Error("session rows did not render");
			expect(beta.getAttribute("aria-current")).toBe("true");
			expect(alpha.getAttribute("aria-current")).toBeNull();
		} finally {
			await sheet.unmount();
		}
	});
});
