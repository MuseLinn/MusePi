import "./happy-dom-shim"; // MUST be first: component module graphs define DOM-backed modules at evaluation time.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type SecretAnswer, SecretCard, type SecretRequest } from "../src/components/SecretCard";

// 密钥请求卡契约（M35）：值只用于一次 secret.answer，输入始终遮罩，
// 提交后不留在任何可读取的 DOM 文本里；已决只保留一行结果。
setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const DEFAULT_REQUEST: SecretRequest = {
	requestId: "r1",
	name: "EXAMPLE_KEY",
	purpose: "Deploy to staging",
	kind: "fill",
};

const mounted = new Set<Root>();

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(5);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

async function renderCard(
	request: Partial<SecretRequest> = {},
	onAnswer: (answer: SecretAnswer) => Promise<void> = async () => {},
): Promise<{ root: Root; host: HTMLElement; request: SecretRequest }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	const full = { ...DEFAULT_REQUEST, ...request };
	await act(async () => root.render(<SecretCard request={full} onAnswer={onAnswer} />));
	await flush();
	return { root, host, request: full };
}

/** happy-dom does not always surface native input events to React's delegated
 *  listener; drive the wired onChange through React props with the native
 *  setter (the pattern capability-panel.test.tsx uses). */
async function typeSecret(host: HTMLElement, value: string): Promise<HTMLInputElement> {
	const input = host.querySelector<HTMLInputElement>("input");
	if (!input) throw new Error("secret input not rendered");
	const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
	const props = (input as unknown as Record<string, { onChange?: (e: { target: Element }) => void }>)[propsKey!];
	if (!props?.onChange) throw new Error("secret input has no React onChange");
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
	await act(async () => props.onChange!({ target: input }));
	await flush();
	return input;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
	const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
		candidate => candidate.textContent?.trim() === text,
	);
	if (!found) throw new Error(`no button ${text}`);
	return found;
}

function isMasked(input: HTMLInputElement): boolean {
	return input.type === "password" && (input.getAttribute("style") ?? "").includes("-webkit-text-security: disc");
}

/** A rejected answer must reach the card as an Error carrying the daemon's
 *  message; the value itself is never part of the failure text. */
async function rejectWith(message: string): Promise<never> {
	throw new Error(message);
}

describe("SecretCard 遮罩与说明", () => {
	test("输入同时使用 password 字段与 -webkit-text-security: disc，并关闭自动填充", async () => {
		const { host } = await renderCard();
		const input = host.querySelector<HTMLInputElement>("input")!;
		expect(isMasked(input)).toBe(true);
		expect(input.type).toBe("password");
		expect(input.getAttribute("style")).toContain("-webkit-text-security: disc");
		expect(input.getAttribute("autocomplete")).toBe("off");
		expect(input.hasAttribute("data-1p-ignore")).toBe(true);
		expect(input.getAttribute("data-lpignore")).toBe("true");
		expect(input.getAttribute("data-bwignore")).toBe("true");
	});

	test("说明文案带上环境变量名与全会话 scope，不复述值", async () => {
		const { host } = await renderCard();
		expect(host.textContent).toContain("$MUSEPI_SECRET_EXAMPLE_KEY");
		expect(host.textContent).toContain("Agent 看不到这个值");
		expect(host.textContent).toContain("所有会话可用");
		expect(host.textContent).toContain("Deploy to staging");
	});
});

describe("SecretCard 提交与已决态", () => {
	test("保存后值不回显：只留一行已安全保存，DOM 不再包含输入值", async () => {
		const calls: SecretAnswer[] = [];
		const { host } = await renderCard({}, async answer => {
			calls.push(answer);
		});
		const secret = "s3cret-value-xyz";
		await typeSecret(host, secret);
		await act(async () => button(host, "保存").click());
		await flush();
		expect(calls).toEqual([{ requestId: "r1", action: "save", value: secret, scope: "all" }]);
		expect(host.querySelector("input")).toBeNull();
		expect(host.textContent).toContain("已安全保存 EXAMPLE_KEY");
		expect(host.innerHTML).not.toContain(secret);
	});

	test("取消路径不带值，只留一行已取消", async () => {
		const calls: SecretAnswer[] = [];
		const { host } = await renderCard({}, async answer => {
			calls.push(answer);
		});
		await typeSecret(host, "s3cret-value-xyz");
		await act(async () => button(host, "取消").click());
		await flush();
		expect(calls).toEqual([{ requestId: "r1", action: "cancel" }]);
		expect(host.querySelector("input")).toBeNull();
		expect(host.textContent).toContain("已取消");
	});

	test("allow 形态没有输入框，只回传 allow", async () => {
		const calls: SecretAnswer[] = [];
		const { host } = await renderCard({ kind: "allow" }, async answer => {
			calls.push(answer);
		});
		expect(host.querySelector("input")).toBeNull();
		await act(async () => button(host, "允许").click());
		await flush();
		expect(calls).toEqual([{ requestId: "r1", action: "allow", scope: "all" }]);
		expect(host.textContent).toContain("已允许 EXAMPLE_KEY");
	});

	test("保存中显示明确态：按钮禁用并显示保存中", async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => {
			release = resolve;
		});
		const { host } = await renderCard({}, () => pending);
		await typeSecret(host, "s3cret-value-xyz");
		await act(async () => button(host, "保存").click());
		await flush();
		expect(button(host, "保存中…").disabled).toBe(true);
		expect(host.querySelector("input")?.hasAttribute("disabled")).toBe(true);
		await act(async () => {
			release();
			await pending;
		});
		await flush();
		expect(host.textContent).toContain("已安全保存 EXAMPLE_KEY");
	});
});

describe("SecretCard 校验与错误", () => {
	test("长度不足：保存禁用并显示至少 8 个字符，不发请求", async () => {
		const calls: SecretAnswer[] = [];
		const { host } = await renderCard({}, async answer => {
			calls.push(answer);
		});
		await typeSecret(host, "short");
		expect(button(host, "保存").disabled).toBe(true);
		expect(host.querySelector(".gui-error")?.textContent).toContain("至少 8 个字符");
		expect(calls).toHaveLength(0);
	});

	test("daemon 错误原样显示，输入保持遮罩可重试", async () => {
		const secret = "s3cret-value-xyz";
		const message = "Secret value must be at least 8 characters";
		const { host } = await renderCard({}, () => rejectWith(message));
		await typeSecret(host, secret);
		await act(async () => button(host, "保存").click());
		await flush();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
		const input = host.querySelector<HTMLInputElement>("input");
		expect(input).not.toBeNull();
		expect(isMasked(input!)).toBe(true);
		expect(input!.value).toBe(secret);
		// 值只存在于输入框属性里，不进入任何文本节点。
		expect(host.textContent).not.toContain(secret);
	});
});
