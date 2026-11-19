import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/styles/pet-window.css"), "utf8");

describe("pet quick-bar composer CSS", () => {
	test("the composing state fades out only the row's own buttons", () => {
		// The field's add and send controls live inside
		// .pet-window__quickbar-composer. A descendant selector on
		// .pet-window__quickbar-btn hid them together with the row, which is
		// why the leading add button never appeared in the open field.
		expect(css).not.toMatch(/\.pet-window__quickbar--composing\s+\.pet-window__quickbar-btn/);
		expect(css).toMatch(/\.pet-window__quickbar--composing\s*>\s*\.pet-window__quickbar-btn/);
	});
});
