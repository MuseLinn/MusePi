import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { EXTENSION_SLOT_DECLARATION, slotKindOf } from "@musepi/collab-proto/extension-slots";
import { navGroups } from "../src/components/SettingsNav";
import { apply as applyConnectors } from "../src/plugins/connectors-settings/index";
import { apply as applyIndexes } from "../src/plugins/index-library/index";

describe("settings pages as Cordis plugins", () => {
	test("connectors and the index library register settings.section entries with their ids", () => {
		const entries: { slot: string; id?: string }[] = [];
		const ctx = {
			slots: {
				register: (component: { slot: string; id?: string }) => entries.push(component),
			},
		};
		applyConnectors(ctx as never);
		applyIndexes(ctx as never);
		expect(entries.map(entry => ({ slot: entry.slot, id: entry.id }))).toEqual([
			{ slot: "settings.section", id: "connectors" },
			{ slot: "settings.section", id: "indexes" },
		]);
	});

	test("a takeover id keeps the built-in nav row instead of adding an ext row", () => {
		const items = navGroups([
			{ id: "connectors", label: "连接器" },
			{ id: "indexes", label: "索引库" },
			{ id: "widgets", label: "小组件" },
			// The retired page ids stay aliases of 会话与记忆, so a takeover entry
			// must not sprout a second nav row either.
			{ id: "sessions", label: "会话" },
			{ id: "memory", label: "记忆" },
		]).flatMap(group => group.items);

		expect(items.filter(item => item.id === "connectors")).toHaveLength(1);
		expect(items.filter(item => item.id === "indexes")).toHaveLength(1);
		expect(items.filter(item => item.id === "session-memory")).toHaveLength(1);
		expect(items.some(item => item.id === "ext:connectors")).toBe(false);
		expect(items.some(item => item.id === "ext:indexes")).toBe(false);
		expect(items.some(item => item.id === "ext:sessions")).toBe(false);
		expect(items.some(item => item.id === "ext:memory")).toBe(false);
		// A genuinely new page gets its own row, keyed by the entry id.
		expect(items.find(item => item.id === "ext:widgets")?.label).toBe("小组件");
	});

	test("owner options name the built-in row's icon, label, order and keywords", () => {
		const groups = navGroups([
			{
				id: "connectors",
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

	test("an entry without an id is not a nav page", () => {
		const items = navGroups([{ label: "no identity" }]).flatMap(group => group.items);
		expect(items.some(item => item.label === "no identity")).toBe(false);
	});
});

describe("settings slot vocabulary (dsh parity)", () => {
	test("pages ride one settings.section list; page rows stay in the item namespace", () => {
		expect(EXTENSION_SLOT_DECLARATION.exact["settings.section"]).toEqual({ kind: "list" });
		expect(slotKindOf("settings.section")).toBe("list");
		expect(EXTENSION_SLOT_DECLARATION.exact["settings.general.item"]).toEqual({ kind: "list" });
		expect(slotKindOf("settings.general.item")).toBe("list");
		// Page-owned rows ride the item namespace, never a second page seat.
		expect(EXTENSION_SLOT_DECLARATION.prefixes).toContain("settings.item.");
		expect(slotKindOf("settings.item.appearance.rail")).toBeUndefined();
		// One spelling per seat: the retired namespaces are gone, so a stale
		// plugin fails loud at registration instead of silently mounting nowhere.
		expect(EXTENSION_SLOT_DECLARATION.prefixes).not.toContain("settings.section.");
		expect(EXTENSION_SLOT_DECLARATION.prefixes).not.toContain("settings.tab.");
		expect(EXTENSION_SLOT_DECLARATION.prefixes).not.toContain("settings.action.");
	});
});
