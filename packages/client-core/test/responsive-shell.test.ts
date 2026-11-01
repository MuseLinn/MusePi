import { describe, expect, it } from "bun:test";
import { shellLayoutForViewport } from "../src/lib/responsive-shell";

describe("shared shell layout classes", () => {
	it("keeps phones, unfolded tablets and desktop web in distinct width classes", () => {
		expect(shellLayoutForViewport(390, 844)).toBe("compact");
		expect(shellLayoutForViewport(600, 900)).toBe("medium");
		expect(shellLayoutForViewport(839, 900)).toBe("medium");
		expect(shellLayoutForViewport(840, 900)).toBe("wide");
	});

	it("uses the compact class for short landscape viewports without inspecting the user agent", () => {
		expect(shellLayoutForViewport(800, 400)).toBe("compact");
		expect(shellLayoutForViewport(1024, 400)).toBe("wide");
	});
});
