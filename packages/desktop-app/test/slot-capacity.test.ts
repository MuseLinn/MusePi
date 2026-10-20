/**
 * 输入区席位的容量语义 — `single` 与 `list` 不是装饰。
 *
 * 这批用例守的是「同一个位置能不能出现两个占据者」这个用户可见契约：
 * `composer.model` 上并排出现两条模型读数，用户不知道该信哪个；而
 * `composer.left` 本来就该并排放多个工具按钮。
 */

import { describe, expect, it } from "bun:test";
import {
	COMPOSER_SLOTS,
	EXTENSION_SLOT_DECLARATION,
	EXTENSION_SLOT_NAMES,
	slotKindOf,
} from "@musepi/collab-proto/extension-slots";

describe("composer slot capacity", () => {
	it("declares the eleven input seats the reference declares", () => {
		// The input area is the surface plugins extend most; a missing seat means
		// a plugin has nowhere correct to mount and lands somewhere wrong.
		expect(COMPOSER_SLOTS).toHaveLength(11);
		for (const slot of COMPOSER_SLOTS) {
			expect(EXTENSION_SLOT_NAMES).toContain(slot as never);
		}
	});

	it("keeps the single-occupant seats single", () => {
		// These five hold ONE thing at a time in the reference contract: a model
		// selector, an attachment rail, a permission control, a plan control and
		// one post-model action. Two contributors would render competing controls.
		for (const slot of [
			"composer.model",
			"composer.attachments",
			"composer.permission",
			"composer.plan",
			"composer.activity",
		]) {
			expect(slotKindOf(slot), slot).toBe("single");
		}
	});

	it("keeps the multi-contributor seats open", () => {
		// Toolbar edges and overlays exist precisely to hold several controls.
		for (const slot of ["composer.left", "composer.right", "composer.dock", "composer.overlay"]) {
			expect(slotKindOf(slot), slot).toBe("list");
		}
	});

	it("every declared exact slot carries a capacity", () => {
		// A seat with no capacity is a seat whose collision behaviour is undefined.
		for (const name of EXTENSION_SLOT_NAMES) {
			expect(slotKindOf(name), name).toBeDefined();
		}
		expect(Object.keys(EXTENSION_SLOT_DECLARATION.exact).length).toBe(EXTENSION_SLOT_NAMES.length);
	});

	it("reports no capacity for an undeclared slot", () => {
		// The daemon rejects undeclared slots; the renderer must not silently
		// treat an unknown name as an ordinary list seat.
		expect(slotKindOf("composer.nope")).toBeUndefined();
		expect(slotKindOf("panel.left")).toBeUndefined();
	});
});
