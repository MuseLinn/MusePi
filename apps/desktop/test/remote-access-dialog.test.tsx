import "./happy-dom-shim";
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteAccessDialog } from "../src/components/RemoteAccessDialog";
import type { RpcClient } from "../src/lib/rpc";

setLocale("zh-CN");
afterAll(() => setLocale("en-US"));

interface DialogHarness {
	host: HTMLDivElement;
	root: Root;
	dialog(): HTMLElement;
	unmount(): Promise<void>;
}

async function renderDialog(request: RpcClient["request"]): Promise<DialogHarness> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const rpc = { request } as RpcClient;
	await act(async () => {
		root.render(
			createElement(RemoteAccessDialog, {
				rpc,
				sessionId: "session-1",
				sessionTitle: "Demo",
				open: true,
				onClose: () => {},
				onOpenDisclaimer: () => {},
			}),
		);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	return {
		host,
		root,
		dialog: () => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!(dialog instanceof HTMLElement)) throw new Error("dialog did not render");
			return dialog;
		},
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function clickButton(dialog: HTMLElement, name: string): void {
	const button = Array.from(dialog.querySelectorAll("button")).find(el => el.textContent?.includes(name));
	if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${name}`);
	act(() => button.click());
}

function clickScope(dialog: HTMLElement, index: number): void {
	const scope = dialog.querySelectorAll('[role="radio"]')[index];
	if (!(scope instanceof HTMLButtonElement)) throw new Error(`scope not found: ${index}`);
	act(() => scope.click());
}

describe("RemoteAccessDialog recovery", () => {
	test("a missing tunnel dependency offers recovery and clears when the scope changes", async () => {
		const harness = await renderDialog(async method => {
			if (method === "remote-access.status") return { hosting: false };
			if (method === "remote-access.start") throw new Error("cloudflared is not installed");
			if (method === "channels.list" || method === "channels.plugins") return [];
			throw new Error(`unexpected rpc: ${method}`);
		});
		try {
			const dialog = harness.dialog();
			clickScope(dialog, 2);
			clickButton(dialog, "开始共享");
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});
			const alert = dialog.querySelector('[role="alert"]');
			expect(alert?.textContent).toContain("安装 Cloudflared");
			expect(alert?.querySelector("details")).not.toBeNull();
			expect(Array.from(alert?.querySelectorAll("button") ?? []).some(el => el.textContent === "重试")).toBe(true);
			clickScope(dialog, 0);
			expect(dialog.querySelector('[role="alert"]')).toBeNull();
		} finally {
			await harness.unmount();
		}
	});

	test("a channel-list failure offers retry instead of claiming no channels exist", async () => {
		const harness = await renderDialog(async method => {
			if (method === "remote-access.status") return { hosting: false };
			if (method === "channels.plugins") return [];
			if (method === "channels.list") throw new Error("daemon unavailable");
			throw new Error(`unexpected rpc: ${method}`);
		});
		try {
			const dialog = harness.dialog();
			const alert = dialog.querySelector(".gui-collab-channels [role='alert']");
			expect(alert?.textContent).toContain("无法加载");
			expect(alert?.textContent).not.toContain("尚未配置渠道");
			expect(Array.from(alert?.querySelectorAll("button") ?? []).some(el => el.textContent === "重试")).toBe(true);
		} finally {
			await harness.unmount();
		}
	});

	test("channel configuration exposes a persistent label for its credential input", async () => {
		const harness = await renderDialog(async method => {
			if (method === "remote-access.status") return { hosting: false };
			if (method === "channels.plugins") return [];
			if (method === "channels.list") return [{ kind: "discord", state: "off", config: {} }];
			throw new Error(`unexpected rpc: ${method}`);
		});
		try {
			const dialog = harness.dialog();
			const configure = dialog.querySelector('button[aria-label="配置 Discord"]');
			if (!(configure instanceof HTMLButtonElement)) throw new Error("channel-specific configure action missing");
			act(() => configure.click());
			expect(configure.getAttribute("aria-expanded")).toBe("true");
			expect(dialog.querySelector('input[aria-label="Bot 令牌"]')).not.toBeNull();
		} finally {
			await harness.unmount();
		}
	});

	test("sharing scope stays fixed while its start request is pending", async () => {
		let rejectStart: ((reason: Error) => void) | undefined;
		const harness = await renderDialog(async method => {
			if (method === "remote-access.status") return { hosting: false };
			if (method === "channels.plugins") return [];
			if (method === "channels.list") return [];
			if (method === "remote-access.start") {
				return new Promise((_resolve, reject) => {
					rejectStart = reject;
				});
			}
			throw new Error(`unexpected rpc: ${method}`);
		});
		try {
			const dialog = harness.dialog();
			clickButton(dialog, "开始共享");
			await act(async () => {
				await Promise.resolve();
			});
			const scopes = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
			expect(scopes).toHaveLength(3);
			expect(scopes.every(scope => scope.disabled)).toBe(true);
			await act(async () => {
				rejectStart?.(new Error("cancelled"));
				await Promise.resolve();
			});
		} finally {
			await harness.unmount();
		}
	});
});
