/**
 * 输入区席位的容量语义 — `single` 与 `list` 不是装饰。
 *
 * 这批用例守的是「同一个位置能不能出现两个占据者」这个用户可见契约：
 * `conversation.input.model` 上并排出现两条模型读数，用户不知道该信哪个；而
 * `conversation.input.left` 本来就该并排放多个工具按钮。
 */

import { describe, expect, it } from "bun:test";
import {
	COMPOSER_SLOTS,
	EXTENSION_SLOT_DECLARATION,
	EXTENSION_SLOT_NAMES,
	slotKindOf,
} from "@musepi/collab-proto/extension-slots";

describe("composer slot capacity", () => {
	it("declares twelve input seats, including the reference's above-card dock", () => {
		// The input area is the surface plugins extend most; a missing seat means
		// a plugin has nowhere correct to mount and lands somewhere wrong.
		expect(COMPOSER_SLOTS).toHaveLength(12);
		expect(COMPOSER_SLOTS).toContain("conversation.input.dock");
		for (const slot of COMPOSER_SLOTS) {
			expect(EXTENSION_SLOT_NAMES).toContain(slot as never);
		}
	});

	it("keeps the single-occupant seats single", () => {
		// These five hold ONE thing at a time in the reference contract: a model
		// selector, an attachment rail, a permission control, a plan control and
		// one post-model action. Two contributors would render competing controls.
		for (const slot of [
			"conversation.input.model",
			"conversation.input.attachments",
			"conversation.input.permission",
			"conversation.input.plan",
			"conversation.input.activity",
		]) {
			expect(slotKindOf(slot), slot).toBe("single");
		}
	});

	it("keeps the multi-contributor seats open", () => {
		// Toolbar edges and overlays exist precisely to hold several controls.
		for (const slot of [
			"conversation.input.left",
			"conversation.input.right",
			"conversation.input.dock",
			"conversation.composer.dock",
			"conversation.input.overlay",
		]) {
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

	it("reserves a list seat for rows inside the Appearance page", () => {
		// dsh names these page-specific item seats (`settings.general.item`);
		// MusePi's dedicated Appearance page gets the same shape.
		expect(slotKindOf("settings.appearance.item")).toBe("list");
	});

	it("reports no capacity for an undeclared slot", () => {
		// The daemon rejects undeclared slots; the renderer must not silently
		// treat an unknown name as an ordinary list seat.
		expect(slotKindOf("composer.nope")).toBeUndefined();
		expect(slotKindOf("panel.left")).toBeUndefined();
	});
});
