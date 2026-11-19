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

interface RpcBehaviors {
	status?: unknown;
	exposures?: unknown;
	start?: (params: Record<string, unknown>) => unknown;
	pair?: unknown;
	channelsList?: () => unknown;
	channelsPlugins?: () => unknown;
}

interface RpcStub {
	request: RpcClient["request"];
	calls: { method: string; params: unknown }[];
}

const LAN_READY = {
	id: "lan",
	label: "Local network",
	health: "ready",
	detail: "same network only (192.168.1.7)",
	capabilities: { guestInstall: false, publicExposure: false, stableUrl: false, thirdParty: false },
};

const CLOUDFLARED_MISSING = {
	id: "cloudflared",
	label: "Cloudflare Tunnel",
	health: "unavailable",
	detail: "cloudflared is not installed",
	hint: "Install cloudflared, then check again.",
	install: {
		url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
		commands: {
			darwin: "brew install cloudflared",
			linux: "curl -L https://pkg.cloudflare.com/cloudflared/install.sh | sudo bash",
			win32: "winget install --id Cloudflare.cloudflared",
		},
		note: "MusePi never installs it for you; quick tunnels need no account.",
	},
	capabilities: { guestInstall: false, publicExposure: true, stableUrl: false, thirdParty: true },
};

const EXPOSURES = {
	default: "lan",
	exposures: [LAN_READY, CLOUDFLARED_MISSING],
};

function rpcStub(behaviors: RpcBehaviors = {}): RpcStub {
	const calls: { method: string; params: unknown }[] = [];
	const request = (async (method: string, params?: unknown) => {
		calls.push({ method, params });
		switch (method) {
			case "channels.list":
				return behaviors.channelsList ? await behaviors.channelsList() : [];
			case "channels.plugins":
				return behaviors.channelsPlugins ? await behaviors.channelsPlugins() : [];
			case "collab.exposures":
				return behaviors.exposures ?? EXPOSURES;
			case "remote-access.status":
				return behaviors.status ?? { hosting: false };
			case "remote-access.start":
				return behaviors.start
					? await behaviors.start((params ?? {}) as Record<string, unknown>)
					: { hosting: true };
			case "remote-access.pair.generate":
				return behaviors.pair ?? { code: "123456", expiresInSeconds: 600, lanHost: "192.168.1.7" };
			default:
				throw new Error(`unexpected rpc: ${method}`);
		}
	}) as RpcClient["request"];
	return { request, calls };
}

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	});
}

async function renderDialog(
	stub: RpcStub,
	props: {
		sessionId?: string | null;
		sessionTitle?: string | null;
		initialScope?: "workspace" | "session";
		allowSessionScope?: boolean;
	} = {},
): Promise<DialogHarness> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			createElement(RemoteAccessDialog, {
				rpc: { request: stub.request } as RpcClient,
				sessionId: props.sessionId === undefined ? "session-1" : props.sessionId,
				sessionTitle: props.sessionTitle === undefined ? "Demo" : props.sessionTitle,
				initialScope: props.initialScope,
				allowSessionScope: props.allowSessionScope,
				open: true,
				onClose: () => {},
				onOpenDisclaimer: () => {},
			}),
		);
	});
	await flush();
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

function findButton(dialog: HTMLElement, name: string): HTMLButtonElement {
	const button = Array.from(dialog.querySelectorAll("button")).find(el => el.textContent?.includes(name));
	if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${name}`);
	return button;
}

function clickButton(dialog: HTMLElement, name: string): void {
	act(() => findButton(dialog, name).click());
}

function radioGroup(dialog: HTMLElement, label: string): HTMLElement | null {
	return dialog.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
}

function clickRadio(dialog: HTMLElement, groupLabel: string, name: string): void {
	const group = radioGroup(dialog, groupLabel);
	const radio = Array.from(group?.querySelectorAll('[role="radio"]') ?? []).find(el => el.textContent?.includes(name));
	if (!(radio instanceof HTMLButtonElement)) throw new Error(`radio not found: ${groupLabel}/${name}`);
	act(() => radio.click());
}

describe("RemoteAccessDialog sharing surface", () => {
	test("an unavailable exposure renders per-platform install guidance without starting", async () => {
		const harness = await renderDialog(rpcStub());
		try {
			const dialog = harness.dialog();
			expect(dialog.textContent).toContain("需要先安装 Cloudflare Tunnel");
			expect(dialog.textContent).toContain("brew install cloudflared");
			expect(dialog.textContent).toContain("winget install --id Cloudflare.cloudflared");
			expect(dialog.textContent).toContain("MusePi never installs it for you");
			expect(findButton(dialog, "查看安装指南").disabled).toBe(false);

			clickRadio(dialog, "网络方式", "Cloudflare Tunnel");
			expect(findButton(dialog, "开始共享").disabled).toBe(true);
			clickRadio(dialog, "网络方式", "局域网");
			expect(findButton(dialog, "开始共享").disabled).toBe(false);
		} finally {
			await harness.unmount();
		}
	});

	test("a failed start is one error block with a retry action and technical details", async () => {
		const stub = rpcStub({
			start: () => {
				throw new Error("relay port unavailable");
			},
		});
		const harness = await renderDialog(stub);
		try {
			const dialog = harness.dialog();
			clickButton(dialog, "开始共享");
			await flush();
			const alerts = dialog.querySelectorAll('.gui-collab-share [role="alert"]');
			expect(alerts).toHaveLength(1);
			expect(alerts[0]?.textContent).toContain("relay port unavailable");
			expect(alerts[0]?.querySelector("details")).not.toBeNull();
			expect(findButton(dialog, "重试")).toBeDefined();

			clickRadio(dialog, "网络方式", "Cloudflare Tunnel");
			expect(dialog.querySelector('.gui-collab-share [role="alert"]')).toBeNull();
		} finally {
			await harness.unmount();
		}
	});

	test("the environment entrance hides the session scope and never names a session", async () => {
		const stub = rpcStub();
		const harness = await renderDialog(stub, {
			sessionTitle: "Secret Demo",
			initialScope: "workspace",
			allowSessionScope: false,
		});
		try {
			const dialog = harness.dialog();
			expect(radioGroup(dialog, "共享范围")).toBeNull();
			expect(dialog.textContent).not.toContain("Secret Demo");
			expect(dialog.textContent).toContain("共享整个工作台");

			clickButton(dialog, "开始共享");
			await flush();
			const start = stub.calls.find(call => call.method === "remote-access.start");
			expect(start?.params).toEqual({ mode: "workspace", exposure: "lan" });
		} finally {
			await harness.unmount();
		}
	});

	test("a session entrance locks its session and never offers the scope switch", async () => {
		const stub = rpcStub();
		const harness = await renderDialog(stub, {
			sessionId: "session-42",
			sessionTitle: "Release notes",
			initialScope: "session",
			allowSessionScope: false,
		});
		try {
			const dialog = harness.dialog();
			expect(radioGroup(dialog, "共享范围")).toBeNull();
			expect(dialog.textContent).toContain("访客只能看到「Release notes」这个会话。");

			clickButton(dialog, "开始共享");
			await flush();
			const start = stub.calls.find(call => call.method === "remote-access.start");
			expect(start?.params).toEqual({ mode: "session", exposure: "lan", sessionId: "session-42" });
		} finally {
			await harness.unmount();
		}
	});

	test("the default panel offers workspace first and starts a workspace share without a session id", async () => {
		const stub = rpcStub();
		const harness = await renderDialog(stub, { sessionId: "session-1" });
		try {
			const dialog = harness.dialog();
			const scopes = radioGroup(dialog, "共享范围")?.querySelectorAll('[role="radio"]') ?? [];
			expect(scopes).toHaveLength(2);
			expect(scopes[0]?.textContent).toContain("工作区");
			expect(scopes[0]?.getAttribute("aria-checked")).toBe("true");

			clickButton(dialog, "开始共享");
			await flush();
			const start = stub.calls.find(call => call.method === "remote-access.start");
			expect(start?.params).toEqual({ mode: "workspace", exposure: "lan" });
		} finally {
			await harness.unmount();
		}
	});

	test("sharing scope stays fixed while its start request is pending", async () => {
		let rejectStart: ((reason: Error) => void) | undefined;
		const stub = rpcStub({
			start: () =>
				new Promise((_resolve, reject) => {
					rejectStart = reject;
				}),
		});
		const harness = await renderDialog(stub);
		try {
			const dialog = harness.dialog();
			clickButton(dialog, "开始共享");
			await flush();
			const scopes = Array.from(
				radioGroup(dialog, "共享范围")?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
			);
			expect(scopes).toHaveLength(2);
			expect(scopes.every(scope => scope.disabled)).toBe(true);
			await act(async () => {
				rejectStart?.(new Error("cancelled"));
			});
		} finally {
			await harness.unmount();
		}
	});

	test("an ended share explains its reason and next step", async () => {
		const harness = await renderDialog(
			rpcStub({
				status: {
					hosting: false,
					lastEnd: {
						exposure: "cloudflared",
						health: "degraded",
						at: "2026-11-19T10:00:00.000Z",
						reason: "exposure degraded",
						detail: "connection reset by peer",
						hint: "Check the tunnel and retry.",
					},
				},
			}),
		);
		try {
			const dialog = harness.dialog();
			expect(dialog.textContent).toContain("分享已结束");
			expect(dialog.textContent).toContain("分享链路中断，旧链接已失效。");
			expect(dialog.textContent).toContain("Check the tunnel and retry.");
			expect(dialog.textContent).toContain("connection reset by peer");
		} finally {
			await harness.unmount();
		}
	});

	test("a degraded live share drops the QR and the old link", async () => {
		const link = "https://192.168.1.7:7654/#ws://192.168.1.7:7654";
		const harness = await renderDialog(
			rpcStub({
				status: {
					hosting: true,
					exposure: "lan",
					webLink: link,
					health: { health: "degraded", detail: "tunnel lost" },
				},
			}),
		);
		try {
			const dialog = harness.dialog();
			expect(dialog.querySelector("canvas")).toBeNull();
			expect(dialog.textContent).not.toContain(link);
			expect(dialog.textContent).not.toContain("复制链接");
			expect(dialog.textContent).not.toContain("获取配对码");
			expect(dialog.textContent).toContain("分享链路已降级");
			expect(dialog.textContent).toContain("链接已停止展示");
		} finally {
			await harness.unmount();
		}
	});

	test("a LAN share offers the pair code and the address the phone must type", async () => {
		const harness = await renderDialog(
			rpcStub({
				status: {
					hosting: true,
					exposure: "lan",
					webLink: "https://192.168.1.7:7654/#ws://192.168.1.7:7654",
					health: { health: "ready" },
				},
			}),
		);
		try {
			const dialog = harness.dialog();
			clickButton(dialog, "获取配对码");
			await flush();
			expect(dialog.textContent).toContain("123456");
			expect(dialog.textContent).toContain("192.168.1.7");
		} finally {
			await harness.unmount();
		}
	});

	test("a public tunnel share shows the full link instead of a pair code", async () => {
		const link = "https://quiet-lake.trycloudflare.com/#wss://quiet-lake.trycloudflare.com";
		const harness = await renderDialog(
			rpcStub({
				exposures: {
					default: "lan",
					exposures: [LAN_READY, { ...CLOUDFLARED_MISSING, health: "ready", install: undefined }],
				},
				status: {
					hosting: true,
					exposure: "cloudflared",
					webLink: link,
					health: { health: "ready" },
				},
			}),
		);
		try {
			const dialog = harness.dialog();
			expect(dialog.textContent).not.toContain("获取配对码");
			expect(dialog.textContent).toContain(link);
			expect(dialog.textContent).toContain("不需要配对码或局域网地址");
		} finally {
			await harness.unmount();
		}
	});
});

describe("RemoteAccessDialog channels", () => {
	test("a channel-list failure offers retry instead of claiming no channels exist", async () => {
		const harness = await renderDialog(
			rpcStub({
				channelsList: () => {
					throw new Error("daemon unavailable");
				},
			}),
		);
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
		const harness = await renderDialog(
			rpcStub({
				channelsList: () => [{ kind: "discord", state: "off", config: {} }],
			}),
		);
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
});
