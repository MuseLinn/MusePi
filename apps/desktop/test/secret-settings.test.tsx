import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { navGroups } from "../src/components/SettingsNav";
import { SecretSettingsSection } from "../src/components/settings-sections/secret-settings";
import { PromptProvider } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";
import { resolveActiveSection } from "../src/lib/settings-nav";

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

class FakeRpc {
	requests: { method: string; params: unknown }[] = [];
	responses = new Map<string, unknown>();
	failures = new Map<string, Error>();

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params: params ?? {} });
		const failure = this.failures.get(method);
		if (failure) return Promise.reject(failure);
		return Promise.resolve(this.responses.get(method) as T);
	}

	calls(method: string): unknown[] {
		return this.requests.filter(request => request.method === method).map(request => request.params);
	}
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	document.body.innerHTML = "";
});

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

/** Drain updates scheduled by a dialog exit or request continuation. */
async function settle(): Promise<void> {
	await act(async () => {
		await Bun.sleep(30);
	});
}

/** Poll a UI/request condition in short act ticks so every state update that
 *  the condition depends on stays inside act(). */
async function waitFor(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) {
			await settle();
			return;
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function mountRpc(rpc: RpcClient | null): Promise<HTMLDivElement> {
	const element = document.createElement("div");
	document.body.appendChild(element);
	root = createRoot(element);
	await act(async () => {
		root?.render(createElement(PromptProvider, null, createElement(SecretSettingsSection, { rpc })));
	});
	await flush();
	host = element;
	return element;
}

async function mount(fake: FakeRpc): Promise<HTMLDivElement> {
	return mountRpc(fake as unknown as RpcClient);
}

function setInput(input: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function secretEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "GITHUB_TOKEN",
		purpose: "拉取私有仓库",
		scope: "all",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement {
	const button = [...scope.querySelectorAll("button")].find(candidate => (candidate.textContent ?? "").includes(text));
	if (!button) throw new Error(`button "${text}" did not render`);
	return button;
}

async function openDeleteConfirm(scope: HTMLElement, name: string): Promise<void> {
	const row = scope.querySelector<HTMLElement>(`[data-secret-name="${name}"]`);
	const button = row?.querySelector<HTMLButtonElement>('[data-secret-action="delete"]');
	if (!button) throw new Error("delete button did not render");
	await act(async () => button.click());
	await act(async () => Bun.sleep(90));
}

describe("设置页密钥", () => {
	test("导航注册了密钥页，并可按 section id 解析", () => {
		const items = navGroups([]).flatMap(group => group.items);
		const row = items.find(item => item.id === "secrets");
		expect(row?.label).toBe("保险库");
		expect(resolveActiveSection("secrets", new Set(items.map(item => item.id)))).toBe("secrets");
	});

	test("空态：静态加密陈述保护方式，空态解释请求卡片，计数与添加动作并列", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });

		const scope = await mount(fake);

		// 保护方式是一行事实 + 一个动作，不是一张三行状态卡。
		expect(scope.textContent).toContain("静态加密");
		expect(scope.textContent).toContain("本机密钥文件");
		expect(buttonByText(scope, "用口令保护").type).toBe("button");
		// 空态不是一句灰字：标题 + 说明请求卡片怎么来。
		expect(scope.textContent).toContain("还没有保存任何内容。");
		expect(scope.textContent).toContain("Agent 索取密钥时会在这里出现");
		// 列头是「已保存 · N」并带一个添加动作。
		expect(scope.textContent).toContain("已保存 · 0");
		expect(buttonByText(scope, "添加密钥").type).toBe("button");
		// 存储事实收在页脚一句话里。
		expect(scope.textContent).toContain("值在本机加密保存");
		expect(fake.calls("secret.status")).toEqual([{}]);
		expect(fake.calls("secret.list")).toEqual([{}]);
	});

	test("后台未连接时不把「未读取」当成空列表", async () => {
		const scope = await mountRpc(null);

		expect(scope.textContent).toContain("后台服务未连接");
		expect(scope.textContent).not.toContain("还没有保存任何内容");
		expect(scope.textContent).not.toContain("已保存 · 0");
		// 存储事实与后台可用性无关，离线时仍然显示。
		expect(scope.textContent).toContain("值在本机加密保存");
	});

	test("list 失败时隐藏数量与空态，只保留读取失败回退", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 3 });
		fake.failures.set("secret.list", new Error("list unavailable"));

		const scope = await mount(fake);

		expect(scope.textContent).toContain("无法加载密钥列表：list unavailable");
		expect(scope.textContent).not.toContain("还没有保存任何内容");
		expect(scope.textContent).not.toContain("已保存 · 0");
		expect(scope.textContent).not.toContain("已保存 · 3");
		expect(scope.textContent).toContain("值在本机加密保存");
	});

	test("列表显示名字、用途、scope 和最后使用时间，且永不渲染值", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 2 });
		fake.responses.set("secret.list", {
			entries: [
				// A value in the payload would be a daemon contract violation;
				// the page must still never put it in the DOM.
				secretEntry({ lastUsedAt: Date.now() - 5 * 60_000, value: "sk-live-LEAKED" }),
				secretEntry({ name: "STRIPE_KEY", purpose: "", createdAt: 1, updatedAt: 1 }),
			],
			count: 2,
		});

		const scope = await mount(fake);

		expect(scope.textContent).toContain("GITHUB_TOKEN");
		expect(scope.textContent).toContain("拉取私有仓库");
		expect(scope.textContent).toContain("最后使用");
		expect(scope.textContent).toContain("STRIPE_KEY");
		expect(scope.textContent).toContain("已保存 · 2");
		expect(scope.textContent).not.toContain("sk-live-LEAKED");
		// 默认值不复述：「所有会话」是常态，不占行内元信息。
		expect(scope.textContent).not.toContain("所有会话");
		// 行不再靠悬停才出现动作：替换与删除始终在 DOM 里可点。
		const row = scope.querySelector<HTMLElement>('[data-secret-name="GITHUB_TOKEN"]');
		expect(row?.querySelector('[data-secret-action="delete"]')).not.toBeNull();

		// Replace opens a masked field with no stored value echoed back.
		const replace = row?.querySelector<HTMLButtonElement>('[data-secret-action="replace"]');
		await act(async () => replace?.click());
		const valueInput = scope.querySelector<HTMLInputElement>('[data-secret-field="value"]');
		expect(valueInput?.type).toBe("password");
		expect(valueInput?.value).toBe("");
		expect(valueInput?.getAttribute("autocomplete")).toBe("new-password");
	});

	test("删除先二次确认：取消不发请求，确认后调用 secret.delete", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 1 });
		fake.responses.set("secret.list", { entries: [secretEntry()], count: 1 });

		const scope = await mount(fake);

		await openDeleteConfirm(scope, "GITHUB_TOKEN");
		const dialog = document.querySelector<HTMLElement>(".gui-dialog--confirm");
		expect(dialog?.textContent).toContain("删除密钥 GITHUB_TOKEN？");
		await act(async () => dialog?.querySelector<HTMLElement>(".gui-btn:not(.gui-btn-primary)")?.click());
		await waitFor(() => document.querySelector(".gui-dialog--confirm") === null, "cancel to close");
		expect(fake.calls("secret.delete")).toEqual([]);

		await openDeleteConfirm(scope, "GITHUB_TOKEN");
		const confirm = document.querySelector<HTMLElement>(".gui-dialog--confirm .gui-btn-primary");
		await act(async () => confirm?.click());
		await waitFor(() => fake.calls("secret.delete").length === 1, "secret.delete");
		expect(fake.calls("secret.delete")).toEqual([{ name: "GITHUB_TOKEN" }]);
		expect(scope.querySelector('[data-secret-name="GITHUB_TOKEN"]')).toBeNull();
	});

	test("状态模型：表单打开时独占正文，不与行列表或空态并存", async () => {
		// 已存 + 打开表单：只有表单，列表行和空态都不渲染。
		const withRows = new FakeRpc();
		withRows.responses.set("secret.status", { mode: "encrypted", count: 2 });
		withRows.responses.set("secret.list", {
			entries: [secretEntry(), secretEntry({ name: "STRIPE_KEY" })],
			count: 2,
		});
		const storedScope = await mount(withRows);
		expect(storedScope.querySelectorAll("[data-secret-name]")).toHaveLength(2);

		await act(async () => buttonByText(storedScope, "添加密钥").click());
		expect(storedScope.querySelector("form[data-secret-form]")).not.toBeNull();
		expect(storedScope.querySelectorAll("[data-secret-name]")).toHaveLength(0);
		// 计数行仍可见（列表事实），但添加动作在表单打开时禁用，避免叠出第二个表单。
		expect(storedScope.textContent).toContain("已保存 · 2");
		expect(buttonByText(storedScope, "添加密钥").disabled).toBe(true);

		// 空库 + 打开表单：只有表单，不再出现「还没有密钥」。
		const empty = new FakeRpc();
		empty.responses.set("secret.status", { mode: "encrypted", count: 0 });
		empty.responses.set("secret.list", { entries: [], count: 0 });
		const emptyScope = await mount(empty);
		expect(emptyScope.textContent).toContain("还没有保存任何内容。");

		await act(async () => buttonByText(emptyScope, "添加密钥").click());
		expect(emptyScope.querySelector("form[data-secret-form]")).not.toBeNull();
		expect(emptyScope.textContent).not.toContain("还没有保存任何内容。");
		expect(emptyScope.querySelector(".gui-secret-empty")).toBeNull();
		// 关闭表单后回到空态，两种正文不会同时存在。
		await act(async () => buttonByText(emptyScope, "取消").click());
		expect(emptyScope.querySelector("form[data-secret-form]")).toBeNull();
		expect(emptyScope.textContent).toContain("还没有保存任何内容。");
	});

	test("表单字段行消费共享的 gui-settings-field 原语，不再是本页私有的字段语法", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "添加密钥").click());

		// 每一行都是共享原语：标签 / 提示挂在 grid area，控件在 control 格里。
		const fields = [...scope.querySelectorAll(".gui-settings-field")];
		expect(fields.length).toBe(3);
		for (const field of fields) {
			expect(field.querySelector(".gui-settings-field-label")).not.toBeNull();
			const control = field.querySelector(".gui-settings-field-control");
			expect(control?.querySelector("input")).not.toBeNull();
		}
		// 页面私有的那套字段类不得再出现（否则就是第二份近似语法）。
		expect(scope.querySelector(".gui-secret-field")).toBeNull();
		expect(scope.querySelector(".gui-secret-field-label")).toBeNull();
	});

	test("添加表单提交名字、值和用途，值输入已遮罩且提交后不回显", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });
		fake.responses.set("secret.set", { entry: secretEntry({ name: "OPENAI_API_KEY" }) });

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "添加密钥").click());

		const name = scope.querySelector<HTMLInputElement>('[data-secret-field="name"]')!;
		const value = scope.querySelector<HTMLInputElement>('[data-secret-field="value"]')!;
		const purpose = scope.querySelector<HTMLInputElement>('[data-secret-field="purpose"]')!;
		expect(value.type).toBe("password");
		setInput(name, "OPENAI_API_KEY");
		setInput(value, "sk-test-123456");
		setInput(purpose, "模型调用");
		await act(async () => scope.querySelector<HTMLFormElement>("form")?.requestSubmit());
		await waitFor(() => fake.calls("secret.set").length === 1, "secret.set");

		expect(fake.calls("secret.set")).toEqual([
			{ name: "OPENAI_API_KEY", value: "sk-test-123456", purpose: "模型调用" },
		]);
		expect(scope.textContent).not.toContain("sk-test-123456");
		expect(scope.querySelector('[data-secret-field="value"]')).toBeNull();
		expect(scope.textContent).toContain("OPENAI_API_KEY");
	});

	test("过短的值在本地拦截，不发 secret.set", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "添加密钥").click());
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="name"]')!, "OPENAI_API_KEY");
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="value"]')!, "abc");
		await act(async () => scope.querySelector<HTMLFormElement>("form")?.requestSubmit());
		await waitFor(() => (scope.textContent ?? "").includes("至少 4 个字符。"), "value length error");

		expect(fake.calls("secret.set")).toEqual([]);
	});

	test("写入失败时在表单里显示 daemon 的原因，而不是静默无动作", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });
		// The store refuses (e.g. an unwritable master-key directory); the
		// reason it gives is the only thing that tells the user what to fix.
		fake.failures.set("secret.set", new Error("secret master key is invalid"));

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "添加密钥").click());
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="name"]')!, "OPENAI_API_KEY");
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="value"]')!, "sk-test-123456");
		await act(async () => scope.querySelector<HTMLFormElement>("form")?.requestSubmit());
		await waitFor(() => (scope.textContent ?? "").includes("secret master key is invalid"), "daemon reason");

		expect(scope.textContent).toContain("保存密钥失败：secret master key is invalid");
		// The form stays open with the reason inside it, so the value is not lost.
		expect(scope.querySelector<HTMLFormElement>("form")).not.toBeNull();
		// A failed write must not fabricate a row or a count.
		expect(scope.textContent).toContain("已保存 · 0");
		expect(scope.querySelector('[data-secret-name="OPENAI_API_KEY"]')).toBeNull();
		expect(scope.textContent).not.toContain("sk-test-123456");
	});

	test("取消表单丢弃输入的值，不保留在组件状态里", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "添加密钥").click());
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="value"]')!, "sk-test-123456");
		await act(async () => buttonByText(scope, "取消").click());

		expect(scope.querySelector('[data-secret-field="value"]')).toBeNull();
		expect(scope.textContent).not.toContain("sk-test-123456");
		expect(fake.calls("secret.set")).toEqual([]);
	});

	test("状态读取失败时给出明确回退文案和重试入口", async () => {
		const fake = new FakeRpc();
		fake.failures.set("secret.status", new Error("local master key unavailable"));
		fake.responses.set("secret.list", { entries: [], count: 0 });

		const scope = await mount(fake);

		expect(scope.textContent).toContain("无法读取密钥库状态：local master key unavailable");
		expect(scope.textContent).toContain("重试");
		// The invariant encryption line stays visible; only availability failed.
		expect(scope.textContent).toContain("值在本机加密保存");
		// Without a readable status the protection row would guess wrong.
		expect(scope.querySelector("[data-secret-protection]")).toBeNull();
	});
});

describe("保险库静态加密", () => {
	test("口令加密：两次一致才提交 secret.encrypt，成功后换成口令保护态", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 0 });
		fake.responses.set("secret.list", { entries: [], count: 0 });
		fake.responses.set("secret.encrypt", {
			mode: "encrypted",
			count: 0,
			protectedBy: "passphrase",
			locked: false,
		});

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "用口令保护").click());

		const form = scope.querySelector<HTMLFormElement>("[data-secret-protection-form]")!;
		expect(form.getAttribute("data-secret-protection-form")).toBe("protect");
		expect(scope.querySelectorAll('input[type="password"]')).toHaveLength(2);

		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="passphrase"]')!, "correct horse battery");
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="confirm"]')!, "correct horse batteru");
		await act(async () => form.requestSubmit());
		await waitFor(() => (scope.textContent ?? "").includes("两次输入的口令不一致。"), "mismatch");
		expect(fake.calls("secret.encrypt")).toEqual([]);

		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="confirm"]')!, "correct horse battery");
		await act(async () => form.requestSubmit());
		await waitFor(() => fake.calls("secret.encrypt").length === 1, "secret.encrypt");
		expect(fake.calls("secret.encrypt")).toEqual([{ passphrase: "correct horse battery" }]);
		await waitFor(() => (scope.textContent ?? "").includes("口令保护"), "passphrase state");
		expect(scope.querySelector('input[type="password"]')).toBeNull();
		expect(scope.innerHTML).not.toContain("correct horse battery");
	});

	test("锁定态只说原因与解锁动作，读写动作全部禁用", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", {
			mode: "encrypted",
			count: 1,
			protectedBy: "passphrase",
			locked: true,
			reason: "missing-passphrase",
		});
		fake.responses.set("secret.list", { entries: [secretEntry()], count: 1 });
		fake.responses.set("secret.unlock", {
			mode: "encrypted",
			count: 1,
			protectedBy: "passphrase",
			locked: false,
		});

		const scope = await mount(fake);

		expect(scope.textContent).toContain("保险库已锁定");
		expect(scope.textContent).toContain("输入口令解锁");
		expect(buttonByText(scope, "添加密钥").disabled).toBe(true);
		expect(scope.querySelector<HTMLButtonElement>('[data-secret-action="replace"]')?.disabled).toBe(true);
		expect(scope.querySelector<HTMLButtonElement>('[data-secret-action="delete"]')?.disabled).toBe(true);

		await act(async () => buttonByText(scope, "解锁").click());
		const form = scope.querySelector<HTMLFormElement>("[data-secret-protection-form]")!;
		expect(form.getAttribute("data-secret-protection-form")).toBe("unlock");
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="passphrase"]')!, "correct horse battery");
		await act(async () => form.requestSubmit());
		await waitFor(() => fake.calls("secret.unlock").length === 1, "secret.unlock");
		expect(fake.calls("secret.unlock")).toEqual([{ passphrase: "correct horse battery" }]);
		await waitFor(() => !(scope.textContent ?? "").includes("保险库已锁定"), "unlocked");
		expect(buttonByText(scope, "添加密钥").disabled).toBe(false);
		expect(scope.innerHTML).not.toContain("correct horse battery");
	});

	test("更换口令：当前与新口令都要输齐才提交 secret.rephrase", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", {
			mode: "encrypted",
			count: 0,
			protectedBy: "passphrase",
			locked: false,
		});
		fake.responses.set("secret.list", { entries: [], count: 0 });
		fake.responses.set("secret.rephrase", {
			mode: "encrypted",
			count: 0,
			protectedBy: "passphrase",
			locked: false,
		});

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "更换口令").click());
		const form = scope.querySelector<HTMLFormElement>('[data-secret-protection-form="change"]');
		expect(form).not.toBeNull();
		expect(scope.querySelectorAll('input[type="password"]')).toHaveLength(3);

		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="passphrase"]')!, "correct horse battery");
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="next"]')!, "another passphrase");
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="confirm"]')!, "another passphras");
		await act(async () => form?.requestSubmit());
		await waitFor(() => (scope.textContent ?? "").includes("两次输入的口令不一致。"), "new mismatch");
		expect(fake.calls("secret.rephrase")).toEqual([]);

		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="confirm"]')!, "another passphrase");
		await act(async () => form?.requestSubmit());
		await waitFor(() => fake.calls("secret.rephrase").length === 1, "secret.rephrase");
		expect(fake.calls("secret.rephrase")).toEqual([{ current: "correct horse battery", next: "another passphrase" }]);
		// The form closes on success and no passphrase is left in any text node.
		expect(scope.querySelector("[data-secret-protection-form]")).toBeNull();
		expect(scope.textContent).not.toContain("correct horse battery");
	});

	test("MCP 授权：按 server 与端点勾选，只写真正变化的 server", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", { mode: "encrypted", count: 1, protectedBy: "key-file", locked: false });
		fake.responses.set("secret.list", { entries: [secretEntry()], count: 1 });
		fake.responses.set("mcp.servers.list", {
			servers: [
				{ name: "github", target: "url:https://mcp.github.example/api", transport: "http" },
				{ name: "local", target: 'stdio:["node","server.js"]', transport: "stdio" },
			],
		});
		fake.responses.set("secret.mcpGrants", {
			servers: [{ server: "local", target: 'stdio:["node","server.js"]', keys: ["GITHUB_TOKEN", "OTHER_TOKEN"] }],
		});
		fake.responses.set("secret.setMcpGrant", { servers: [] });

		const scope = await mount(fake);
		const row = scope.querySelector<HTMLElement>('[data-secret-name="GITHUB_TOKEN"]')!;
		await act(async () => row.querySelector<HTMLButtonElement>('[data-secret-action="mcp"]')?.click());
		await waitFor(() => scope.querySelector("[data-secret-grant-form]") !== null, "grant form");

		const local = scope.querySelector<HTMLElement>('[data-mcp-server="local"]')!;
		const github = scope.querySelector<HTMLElement>('[data-mcp-server="github"]')!;
		// The already-granted endpoint starts checked; the other does not.
		expect(local.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
		expect(github.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
		// The endpoint is the thing being approved, so it is visible.
		expect(github.textContent).toContain("https://mcp.github.example/api");

		await act(async () => github.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
		await act(async () => scope.querySelector<HTMLFormElement>("[data-secret-grant-form]")?.requestSubmit());
		await waitFor(() => fake.calls("secret.setMcpGrant").length === 1, "setMcpGrant");

		// `local` learned nothing new, so only `github` is written.
		expect(fake.calls("secret.setMcpGrant")).toEqual([
			{ server: "github", target: "url:https://mcp.github.example/api", keys: ["GITHUB_TOKEN"] },
		]);
		expect(scope.querySelector("[data-secret-grant-form]")).toBeNull();
	});

	test("关闭口令走 secret.decrypt，失败原因留在卡里可重试", async () => {
		const fake = new FakeRpc();
		fake.responses.set("secret.status", {
			mode: "encrypted",
			count: 0,
			protectedBy: "passphrase",
			locked: false,
		});
		fake.responses.set("secret.list", { entries: [], count: 0 });
		fake.failures.set("secret.decrypt", new Error("The passphrase did not unlock the secret store"));

		const scope = await mount(fake);
		await act(async () => buttonByText(scope, "关闭口令").click());
		const form = scope.querySelector<HTMLFormElement>("[data-secret-protection-form]")!;
		setInput(scope.querySelector<HTMLInputElement>('[data-secret-field="passphrase"]')!, "wrong passphrase!");
		await act(async () => form.requestSubmit());
		await waitFor(() => (scope.textContent ?? "").includes("无法修改口令保护"), "decrypt failure");
		expect(scope.textContent).toContain("The passphrase did not unlock the secret store");
		// The typed passphrase is not echoed into any text node.
		expect(scope.textContent).not.toContain("wrong passphrase!");
	});
});
