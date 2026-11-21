import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppRail, type RailItem, UserAccountButton } from "../src/components/AppRail";
import type { RpcClient } from "../src/lib/rpc";

/**
 * Account control contract.
 *
 * The rail's settings gear is gone: the user picture is the permanent
 * bottom-left entry, and the menu behind it owns every action that used to
 * live beside it (Settings / shortcuts / share / host switching / disconnect).
 * The assertions pin the user report (「用户头像放在左边栏底部替代设置按钮」):
 *  * exactly one account entry, and NO settings destination button anywhere
 *    in the rail (the old gear must not survive as a duplicate);
 *  * the menu reaches settings, shortcuts, session sharing, WORKSPACE
 *    remote access (the old rail entry, needed with no session open), a host
 *    list and disconnect;
 *  * disconnect is disabled while no daemon is connected (no dead control);
 *  * Settings closes the menu and calls the host.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const rpc = {
	request: async (method: string) => {
		// No git identity in this fixture: the control must still render.
		if (method === "fs.read") return { content: null };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const mounted: Root[] = [];

afterEach(() => {
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	localStorage.clear();
});

const destination = (id: string): RailItem => ({
	id,
	label: "general.sessions",
	icon: "chat-1",
	onSelect: () => {},
});

function renderRail(
	overrides: {
		connected?: boolean;
		onOpenSettings?: () => void;
		onOpenRemoteAccess?: () => void;
		onDisconnect?: () => void;
	} = {},
) {
	const calls = { settings: 0, remoteAccess: 0, disconnect: 0 };
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push(root);
	act(() => {
		root.render(
			createElement(AppRail, {
				destinations: [destination("home"), destination("board")],
				account: createElement(UserAccountButton, {
					rpc,
					cwd: "C:/workspace",
					hosts: [{ id: "h1", label: "工作室", url: "ws://10.0.0.2:8300" }],
					daemonUrl: "ws://127.0.0.1:8300",
					connected: overrides.connected ?? true,
					onOpenSettings: () => {
						calls.settings += 1;
						overrides.onOpenSettings?.();
					},
					onOpenShortcuts: () => {},
					onOpenCollab: () => {},
					onOpenRemoteAccess: () => {
						calls.remoteAccess += 1;
						overrides.onOpenRemoteAccess?.();
					},
					onSwitchHost: () => {},
					onDisconnect: () => {
						calls.disconnect += 1;
						overrides.onDisconnect?.();
					},
				}),
				panelAvailable: true,
				onTogglePanel: () => {},
			}),
		);
	});
	const nav = host.querySelector("nav");
	if (!(nav instanceof HTMLElement)) throw new Error("rail did not render a <nav>");
	const button = (): HTMLButtonElement => {
		const el = nav.querySelector<HTMLButtonElement>(".gui-account-btn");
		if (!el) throw new Error("no account button");
		return el;
	};
	const openMenu = (): HTMLElement => {
		act(() => button().click());
		const menu = document.querySelector<HTMLElement>(".gui-account-menu");
		if (!menu) throw new Error("account menu did not open");
		return menu;
	};
	return { nav, calls, button, openMenu };
}

describe("rail account control", () => {
	test("the user picture is the only bottom entry — no settings gear remains", () => {
		const rail = renderRail();
		expect(rail.nav.querySelectorAll(".gui-account-btn").length).toBe(1);
		expect(rail.nav.querySelector('[data-rail-destination="settings"]')).toBeNull();
		// The gear was an icon button; nothing in the rail may still be one.
		const labels = [...rail.nav.querySelectorAll("button")].map(el => el.getAttribute("aria-label") ?? "");
		expect(labels).not.toContain("设置");
		expect(rail.button().getAttribute("aria-haspopup")).toBe("menu");
	});

	test("the menu carries settings, shortcuts, sharing, hosts and disconnect", () => {
		const rail = renderRail();
		const menu = rail.openMenu();
		const text = menu.textContent ?? "";
		expect(text).toContain("设置");
		expect(text).toContain("快捷键");
		expect(text).toContain("分享当前会话");
		expect(text).toContain("远程访问");
		expect(text).toContain("切换主机");
		expect(text).toContain("本地");
		expect(text).toContain("工作室");
		expect(text).toContain("断开");
		expect(menu.querySelectorAll(".gui-account-host").length).toBe(2);
	});

	test("workspace remote access is reachable without a session", async () => {
		const rail = renderRail();
		const menu = rail.openMenu();
		const remote = [...menu.querySelectorAll("button")].find(el => el.textContent?.includes("远程访问"));
		expect(remote).toBeDefined();
		await act(async () => remote?.click());
		expect(rail.calls.remoteAccess).toBe(1);
		// It is not the session-share row: that one needs an open session.
		expect(menu.textContent ?? "").toContain("分享当前会话");
	});

	test("workspace remote access stays reachable with no connection/session", () => {
		// The welcome shape has no session and may be disconnected; the row is
		// chrome-owned and must not be gated on either.
		const rail = renderRail({ connected: false });
		const menu = rail.openMenu();
		expect(menu.textContent ?? "").toContain("远程访问");
	});

	test("the local host dot follows the daemon connection", () => {
		const rail = renderRail({ connected: false });
		const menu = rail.openMenu();
		const local = [...menu.querySelectorAll(".gui-account-host")].find(el => el.textContent?.includes("本地"));
		expect(local?.querySelector(".gui-account-host-dot--on")).toBeNull();
	});

	test("settings is reachable from the menu and closes it", async () => {
		const rail = renderRail();
		const menu = rail.openMenu();
		const settings = [...menu.querySelectorAll("button")].find(el => el.textContent?.includes("设置"));
		expect(settings).toBeDefined();
		await act(async () => settings?.click());
		expect(rail.calls.settings).toBe(1);
		// The popup plays its exit animation before unmounting (MENU_ANIM_MS).
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
		});
		expect(document.querySelector(".gui-account-menu")).toBeNull();
	});

	test("disconnect is disabled while nothing is connected", () => {
		const rail = renderRail({ connected: false });
		const menu = rail.openMenu();
		const disconnect = [...menu.querySelectorAll("button")].find(el => el.textContent?.includes("断开"));
		expect(disconnect?.hasAttribute("disabled")).toBe(true);
		act(() => disconnect?.click());
		expect(rail.calls.disconnect).toBe(0);
	});
});
