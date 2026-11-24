/**
 * 设置 → 外观 → Agent 头像样式: the avatar style belongs to the appearance page,
 * and the ball's own detail (球面光泽 / 配饰) only exists on the 桌宠小球
 * preset — no other preset has those layers, so the rows must not follow them
 * around.
 */
import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AVATAR_PRESETS } from "../src/components/avatar-presets";
import { AppearanceSection } from "../src/components/settings-sections/appearance";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	localStorage.clear();
});

function mount(): HTMLDivElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => {
		root?.render(<AppearanceSection showAvatars onToggleAvatars={() => {}} rpc={null} />);
	});
	host = el;
	return el;
}

function avatarSection(scope: HTMLElement): HTMLElement {
	const title = [...scope.querySelectorAll(".gui-settings-section-title")].find(
		n => n.textContent === t("settings.agentAvatarStyle"),
	);
	const section = title?.closest(".gui-settings-section");
	if (!section) throw new Error("avatar style section missing from appearance");
	return section;
}

describe("agent avatar style in appearance", () => {
	it("renders every preset under the appearance page", () => {
		const section = avatarSection(mount());
		expect(section.querySelectorAll(".gui-avatar-card")).toHaveLength(AVATAR_PRESETS.length);
	});

	it("shows the ball's gloss and accessory only for the pet preset", () => {
		localStorage.setItem("musepi-gui-avatar", "pet");
		const section = avatarSection(mount());
		const labels = [...section.querySelectorAll(".gui-settings-row-label")].map(n => n.textContent);
		expect(labels).toContain(t("settings.petDecorGloss"));
		expect(labels).toContain(t("settings.petAccessory"));
		expect(section.querySelector(".gui-pet-accessory-picker")).not.toBeNull();
	});

	it("keeps the ball detail off every other preset", () => {
		for (const id of ["orbs", "hex", "spark", "aora"]) {
			localStorage.setItem("musepi-gui-avatar", id);
			const section = avatarSection(mount());
			const labels = [...section.querySelectorAll(".gui-settings-row-label")].map(n => n.textContent);
			expect(labels).not.toContain(t("settings.petDecorGloss"));
			expect(section.querySelector(".gui-pet-accessory-picker")).toBeNull();
			act(() => root?.unmount());
			root = null;
			host?.remove();
			host = null;
			localStorage.clear();
		}
	});

	it("keeps the pixel face row with the punk preset only", () => {
		localStorage.setItem("musepi-gui-avatar", "punk");
		const punk = avatarSection(mount());
		expect(punk.textContent).toContain(t("settings.pixelFace"));
		act(() => root?.unmount());
		root = null;
		host?.remove();
		host = null;
		localStorage.clear();

		localStorage.setItem("musepi-gui-avatar", "hex");
		const hex = avatarSection(mount());
		expect(hex.textContent).not.toContain(t("settings.pixelFace"));
	});
});
