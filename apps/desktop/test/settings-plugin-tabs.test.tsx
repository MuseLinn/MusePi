import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { navGroups } from "../src/components/SettingsNav";
import { apply as applyConnectors } from "../src/plugins/connectors-settings/index";
import { apply as applyIndexes } from "../src/plugins/index-library/index";

describe("settings pages as Cordis plugins", () => {
	test("connectors and the index library register their settings slots", () => {
		const slots: string[] = [];
		const ctx = {
			slots: {
				register: (component: { slot: string }) => slots.push(component.slot),
			},
		};
		applyConnectors(ctx as never);
		applyIndexes(ctx as never);
		expect(slots).toEqual(["settings.tab.connectors", "settings.tab.indexes"]);
	});

	test("a takeover slot keeps the built-in nav row instead of adding an ext row", () => {
		const items = navGroups([
			{ slot: "settings.tab.connectors", label: "连接器" },
			{ slot: "settings.tab.indexes", label: "索引库" },
			// The retired page ids stay aliases of 会话与记忆, so a takeover slot
			// must not sprout a second nav row either.
			{ slot: "settings.tab.sessions", label: "会话" },
			{ slot: "settings.tab.memory", label: "记忆" },
			{ slot: "settings.tab.widgets", label: "小组件" },
		]).flatMap(group => group.items);

		expect(items.filter(item => item.id === "connectors")).toHaveLength(1);
		expect(items.filter(item => item.id === "indexes")).toHaveLength(1);
		expect(items.filter(item => item.id === "session-memory")).toHaveLength(1);
		expect(items.some(item => item.id === "ext:settings.tab.connectors")).toBe(false);
		expect(items.some(item => item.id === "ext:settings.tab.indexes")).toBe(false);
		expect(items.some(item => item.id === "ext:settings.tab.sessions")).toBe(false);
		expect(items.some(item => item.id === "ext:settings.tab.memory")).toBe(false);
		// A genuinely new page still gets its row.
		expect(items.find(item => item.id === "ext:settings.tab.widgets")?.label).toBe("小组件");
	});
});
