import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { EXTENSION_SLOT_DECLARATION, slotKindOf } from "@musepi/collab-proto/extension-slots";
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
		expect(slots).toEqual(["settings.section.connectors", "settings.section.indexes"]);
	});

	test("a takeover slot keeps the built-in nav row instead of adding an ext row", () => {
		const items = navGroups([
			{ slot: "settings.section.connectors", label: "连接器" },
			{ slot: "settings.section.indexes", label: "索引库" },
			// Legacy spelling stays accepted (plugins shipped before the rename).
			{ slot: "settings.section.widgets", label: "小组件" },
			// The retired page ids stay aliases of 会话与记忆, so a takeover slot
			// must not sprout a second nav row either.
			{ slot: "settings.section.sessions", label: "会话" },
			{ slot: "settings.section.memory", label: "记忆" },
		]).flatMap(group => group.items);

		expect(items.filter(item => item.id === "connectors")).toHaveLength(1);
		expect(items.filter(item => item.id === "indexes")).toHaveLength(1);
		expect(items.filter(item => item.id === "session-memory")).toHaveLength(1);
		expect(items.some(item => item.id === "ext:settings.section.connectors")).toBe(false);
		expect(items.some(item => item.id === "ext:settings.section.indexes")).toBe(false);
		expect(items.some(item => item.id === "ext:settings.section.sessions")).toBe(false);
		expect(items.some(item => item.id === "ext:settings.section.memory")).toBe(false);
		expect(items.some(item => item.id.startsWith("ext:settings.section.memory"))).toBe(false);
		// A genuinely new page still gets its row, through the legacy prefix too.
		expect(items.find(item => item.id === "ext:settings.section.widgets")?.label).toBe("小组件");
	});

	test("owner options name the built-in row's icon, label, order and keywords", () => {
		const groups = navGroups([
			{
				slot: "settings.section.connectors",
				label: "Remote tools",
				icon: "star",
				order: -1,
				keywords: ["remote mcp"],
			},
		]);
		const items = groups.flatMap(group => group.items);
		const row = items.find(item => item.id === "connectors")!;
		expect(row.label).toBe("Remote tools");
		expect(row.icon).toBe("star");
		expect(row.keywords).toEqual(["remote mcp"]);
		// order positions it inside the group (the alias pages keep their own).
		const agentGroup = groups.find(group => group.items.some(item => item.id === "connectors"))!;
		expect(agentGroup.items[0]!.id).toBe("connectors");
	});
});

describe("settings slot vocabulary (dsh parity)", () => {
	test("canonical page/row slots are declared and the legacy spellings stay accepted", () => {
		// Canonical names from the dsh contract.
		expect(EXTENSION_SLOT_DECLARATION.prefixes).toContain("settings.section.");
		expect(EXTENSION_SLOT_DECLARATION.exact["settings.general.item"]).toEqual({ kind: "list" });
		// Row seat: `settings.general.item` is an exact list seat; the page rows
		// keep their pattern.
		expect(slotKindOf("settings.general.item")).toBe("list");
		// Page-owned rows live under the section namespace (dsh `children`),
		// not in a second exact seat.
		expect(slotKindOf("settings.section.appearance.item")).toBeUndefined();
		// One spelling per seat: the retired namespaces are gone, so a stale
		// plugin fails loud at registration instead of silently mounting nowhere.
		expect(EXTENSION_SLOT_DECLARATION.prefixes).not.toContain("settings.tab.");
		expect(EXTENSION_SLOT_DECLARATION.prefixes).not.toContain("settings.action.");
	});
});
