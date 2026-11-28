import { describe, expect, test } from "bun:test";
import { clipPathForAnchor } from "./view-transition";

const surface = { top: 56, right: 336, bottom: 784, left: 80 };
const anchor = { top: 64, right: 322, bottom: 90, left: 296 };

describe("clipPathForAnchor", () => {
	test("converts a viewport anchor into the surface's local inset", () => {
		expect(clipPathForAnchor(anchor, surface, 8)).toBe("inset(8px 14px 694px 216px round 8px)");
	});

	test("clamps an anchor that crosses the surface edge", () => {
		expect(clipPathForAnchor({ top: 48, right: 340, bottom: 60, left: 72 }, surface, 6)).toBe(
			"inset(0px 0px 724px 0px round 6px)",
		);
	});
});
