import { describe, expect, test } from "bun:test";
import { isDividerOnly } from "../src/components/ContextMenu";

/**
 * Issue #13 — the project folder context menu inserted a bare `{ divider: true }`
 * between "copy path" and "remove project". ContextMenu rendered the divider AND
 * an empty `<button role="menuitem">` for it, so users saw a blank clickable row.
 * A divider is a separator only when it carries nothing to show; otherwise
 * (`{ divider: true, label: … }` — how the group menus do it) it decorates a
 * real row and must keep rendering that row.
 */

describe("ContextMenu divider classification", () => {
	test("a bare divider is a standalone separator", () => {
		expect(isDividerOnly({ divider: true })).toBe(true);
	});

	test("a divider hanging on a real item is NOT standalone", () => {
		expect(isDividerOnly({ divider: true, label: "remove project", onSelect: () => {} })).toBe(false);
	});

	test("an item without divider is never standalone", () => {
		expect(isDividerOnly({})).toBe(false);
		expect(isDividerOnly({ label: "copy path" })).toBe(false);
	});

	test("any content on a divider item keeps it a row", () => {
		expect(isDividerOnly({ divider: true, label: "x" })).toBe(false);
		expect(isDividerOnly({ divider: true, description: "x" })).toBe(false);
		expect(isDividerOnly({ divider: true, icon: "delete-bin" })).toBe(false);
		expect(isDividerOnly({ divider: true, onSelect: () => {} })).toBe(false);
	});
});
