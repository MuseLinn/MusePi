import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MockConversationPreview } from "../src/components/MockConversationPreview";

/**
 * Settings → 效果预览 must preview what the avatar toggle really does.
 *
 * The real chat has ONE identity capsule over the transcript and no per-row
 * avatars, so the mock previews exactly that: the capsule's orb follows
 * 显示头像 while the status text stays, and every row keeps an empty gutter.
 * A preview that still painted row avatars contradicted both the chat and the
 * setting's own description.
 */

const roots = new Set<Root>();

beforeEach(() => {
	setLocale("zh-CN");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
	setLocale("en-US");
});

async function mount(showAvatars: boolean): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () => {
		root.render(<MockConversationPreview showAvatars={showAvatars} />);
	});
	return {
		host,
		unmount: async () => {
			roots.delete(root);
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

describe("effects preview identity", () => {
	it("renders one centered capsule over the mock conversation", async () => {
		const { host, unmount } = await mount(false);
		const identity = host.querySelector(".gui-effect-preview-identity");
		expect(identity).not.toBeNull();
		expect(identity?.querySelectorAll(".gui-agent-capsule").length).toBe(1);
		expect(identity?.querySelector(".gui-agent-capsule-name")?.textContent).toBe("助手");
		expect(identity?.querySelector(".gui-agent-capsule-status")?.textContent).toBe("空闲");
		await unmount();
	});

	it("carries the same role reading as the real capsule", async () => {
		const { host, unmount } = await mount(true);
		const capsule = host.querySelector(".gui-agent-capsule");
		// Workbench lane: the name is the assistant, the tag names the lane.
		expect(capsule?.getAttribute("data-agent-role")).toBe("coder");
		expect(capsule?.querySelector(".gui-agent-role-tag")?.textContent).toBe("编码");
		// The role tag sits between the name and the state, as in the chat.
		const order = Array.from(capsule?.children ?? []).map(child => child.className);
		expect(order.indexOf("gui-agent-role-tag")).toBe(order.indexOf("gui-agent-capsule-name") + 1);
		expect(order.indexOf("gui-agent-capsule-status")).toBeGreaterThan(order.indexOf("gui-agent-role-tag"));
		await unmount();
	});

	it("draws the capsule orb at the real capsule's 24px", async () => {
		const { host, unmount } = await mount(true);
		const orb = host.querySelector<HTMLCanvasElement>(".gui-agent-capsule .gui-agent-avatar canvas");
		expect(orb?.style.width).toBe("24px");
		expect(orb?.style.height).toBe("24px");
		await unmount();
	});

	it("drops the capsule orb when the toggle is off, keeping the role and status", async () => {
		const { host, unmount } = await mount(false);
		expect(host.querySelector(".gui-agent-capsule .gui-agent-avatar")).toBeNull();
		expect(host.querySelector(".gui-agent-capsule-status")?.textContent).toBe("空闲");
		expect(host.querySelector(".gui-agent-capsule .gui-agent-role-tag")?.textContent).toBe("编码");
		await unmount();
	});

	it("draws the capsule orb when the toggle is on", async () => {
		const { host, unmount } = await mount(true);
		expect(host.querySelector(".gui-agent-capsule .gui-agent-avatar")).not.toBeNull();
		await unmount();
	});

	it("never paints per-row avatars, in either toggle state", async () => {
		for (const on of [false, true]) {
			const { host, unmount } = await mount(on);
			expect(host.querySelectorAll(".tr-row .gui-user-avatar").length).toBe(0);
			expect(host.querySelectorAll(".tr-row .gui-agent-avatar").length).toBe(0);
			for (const gutter of host.querySelectorAll(".tr-row .tr-gutter")) {
				expect(gutter.childElementCount).toBe(0);
			}
			// The capsule is chrome above the rows, not a transcript row.
			expect(host.querySelector(".tr-row .gui-agent-capsule")).toBeNull();
			await unmount();
		}
	});
});
