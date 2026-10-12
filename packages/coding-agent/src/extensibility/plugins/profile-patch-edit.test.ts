/**
 * Profile patch editing contract.
 *
 * The behaviour this writer owes the person whose file it edits:
 *
 * - **Toggling twice does not grow the file.** The last override for an id wins,
 *   so a second toggle rewrites it (DSH does the same —
 *   `deepseek-harness/packages/boot/plugin-manager/src/patch.ts:30-40`).
 * - **Comments and formatting survive.** This host has no comment-preserving
 *   YAML library (Bun's `stringify` emits flow style), so the writer edits
 *   lines; anything a re-serialization would have reformatted is exactly what a
 *   round-trip test would have caught.
 * - **A row the profile does not compose is refused**, rather than leaving a
 *   patch entry that silently does nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeRowEnabled } from "./profile-patch-edit";

let dir: string;
let patchPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-edit-"));
	patchPath = path.join(dir, "cordis.patch.yml");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(content: string): void {
	fs.writeFileSync(patchPath, content, "utf8");
}

function read(): string {
	return fs.readFileSync(patchPath, "utf8");
}

describe("writeRowEnabled", () => {
	it("creates the patch file on the first toggle", async () => {
		const result = await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		expect(result).toEqual({ kind: "created" });
		expect(read()).toContain("- id: schedule");
		expect(read()).toContain("disabled: true");
	});

	it("disables a row on the first toggle and re-enables it on the next, without growing the file", async () => {
		await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);
		const afterFirst = read();

		const second = await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", true);

		expect(second.kind).toBe("updated");
		// One entry, not two: the override was edited in place.
		expect(read().match(/- id: schedule/g)?.length).toBe(1);
		expect(read()).toContain("disabled: false");
		expect(afterFirst).not.toBe(read());
	});

	it("keeps comments and the author's formatting in a hand-edited file", async () => {
		write(
			[
				"# my work profile — do not reformat",
				"- insert:",
				"    - id: other",
				"      name: '@demo/other'",
				"",
				"# schedule is off on this machine",
				"- id: schedule",
				"  disabled: false",
				"",
			].join("\n"),
		);

		await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		const text = read();
		expect(text).toContain("# my work profile — do not reformat");
		expect(text).toContain("# schedule is off on this machine");
		expect(text).toContain("- insert:");
		// Only the one value changed.
		expect(text).toContain("  disabled: true");
		expect(text).not.toContain("disabled: false");
	});

	it("appends an override for a row the file does not mention yet", async () => {
		write(["- insert:", "    - id: other", "      name: '@demo/other'", ""].join("\n"));

		const result = await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		expect(result.kind).toBe("updated");
		expect(read()).toContain("- id: schedule");
		expect(read()).toContain("  disabled: true");
		// The existing insert entry is untouched.
		expect(read()).toContain("- insert:");
	});

	it("refuses a row the profile does not compose", async () => {
		write("- id: schedule\n  disabled: false\n");

		const result = await writeRowEnabled(patchPath, "typo-row", "@demo/typo", false, ["schedule"]);

		expect(result).toEqual({ kind: "unknown-row", id: "typo-row" });
		// Nothing was written — a patch entry for a row that does not exist
		// would silently do nothing, or start doing something later.
		expect(read()).toBe("- id: schedule\n  disabled: false\n");
	});

	it("leaves an override naming a different row alone", async () => {
		// The file's `schedule` entry names another package: the write is for
		// this profile's schedule row, which is a different thing.
		write("- id: schedule\n  name: '@other/plugin'\n  disabled: false\n");

		const result = await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		expect(result.kind).toBe("updated");
		expect(read()).toContain("- id: schedule");
		// Appended rather than edited: the named entry was not ours.
		expect(read().match(/- id: schedule/g)?.length).toBe(2);
		expect(read()).toContain("  disabled: true");
	});

	it("reports no change when the override already says what was asked", async () => {
		write("- id: schedule\n  disabled: true\n");

		const result = await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		expect(result).toEqual({ kind: "updated", changed: false });
		expect(read()).toBe("- id: schedule\n  disabled: true\n");
	});

	it("adds the field to an override that never had one", async () => {
		write("- id: schedule\n  name: '@demo/plugin-schedule'\n");

		await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		expect(read()).toContain("disabled: true");
	});

	it("round-trips a !!js condition in another row instead of mangling it", async () => {
		// The host does not evaluate `!!js`, but a profile may carry one from
		// DSH. Toggling a sibling row must leave the condition as the tagged
		// expression it was — a line editor or a default tag resolution would
		// rewrite it into a bare string, silently changing what the author wrote.
		write(
			[
				"- id: win-only",
				"  disabled: !!js process.platform === 'win32'",
				"- id: schedule",
				"  disabled: false",
				"",
			].join("\n"),
		);

		await writeRowEnabled(patchPath, "schedule", "@demo/plugin-schedule", false);

		expect(read()).toContain("!!js process.platform === 'win32'");
		expect(read()).toContain("disabled: true");
	});
});
