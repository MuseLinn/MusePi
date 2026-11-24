/**
 * 设置 → 常规 → 电源: the daemon's schema labels are English literals, so the
 * GUI localizes them through the client dictionary. A missing entry painted
 * the whole group (heading included) in English inside an otherwise Chinese
 * page. These assertions feed the REAL schema definition into SchemaSettings,
 * so the contract cannot drift away from settings-schema.ts.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SETTINGS_SCHEMA } from "../../../packages/coding-agent/src/config/settings-schema";
import { SchemaSettings } from "../src/components/SchemaSettings";

type SchemaItem = Parameters<typeof SchemaSettings>[0]["items"][number];

const powerItems = (["power.sleepPrevention", "power.preventLidSleep"] as const).map(key => {
	const def = SETTINGS_SCHEMA[key];
	return { key, type: def.type, default: def.default, ui: def.ui } as unknown as SchemaItem;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	setLocale("en-US");
});

function mount(locale: "zh-CN" | "en-US"): HTMLDivElement {
	setLocale(locale);
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => {
		root?.render(
			createElement(SchemaSettings, {
				items: powerItems,
				values: { "power.sleepPrevention": "sleep", "power.preventLidSleep": false },
				onChange: () => {},
			}),
		);
	});
	host = el;
	return el;
}

function rowTexts(scope: HTMLElement): { group: string; labels: string[]; hints: string[]; trigger: string } {
	const group = scope.querySelector(".gui-settings-group-h")?.textContent ?? "";
	const labels = [...scope.querySelectorAll(".gui-settings-row-label-text")].map(n => n.textContent ?? "");
	const hints = [...scope.querySelectorAll(".gui-settings-row .text-\\[12\\.5px\\]")].map(n => n.textContent ?? "");
	const trigger = scope.querySelector(".gui-select-trigger")?.textContent ?? "";
	return { group, labels, hints, trigger };
}

describe("power settings localization", () => {
	it("renders the group, rows and choices in Chinese", () => {
		const scope = mount("zh-CN");
		const { group, labels, hints, trigger } = rowTexts(scope);
		expect(group).toBe("电源");
		expect(labels).toEqual(["开盖时防止休眠", "合盖后防止休眠"]);
		expect(hints).toContain("设置开盖且闲置时的休眠与息屏方式");
		expect(hints).toContain(
			"合盖后智能体继续执行任务，不改变开盖时的设置；持续耗电，建议接通电源。Windows 首次启用需要管理员授权",
		);
		expect(trigger).toBe("防止休眠，允许息屏");
		for (const text of [group, ...labels, ...hints, trigger]) expect(text).not.toMatch(/Prevent sleep|Power\b/);
	});

	it("keeps the English copy in en-US", () => {
		const scope = mount("en-US");
		const { group, labels, trigger } = rowTexts(scope);
		expect(group).toBe("Power");
		expect(labels).toEqual(["Prevent sleep with the lid open", "Prevent sleep after closing the lid"]);
		expect(trigger).toBe("Prevent sleep, allow display sleep");
	});
});
