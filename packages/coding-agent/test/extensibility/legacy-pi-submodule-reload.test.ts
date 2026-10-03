import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	extensionEntriesNeedingReload,
	loadLegacyPiModule,
} from "@musepi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@musepi/pi-utils";

// HMR used to key its change detection on the entry file's mtime alone, while
// the cache-bust tag re-read the whole graph on every load. So editing any file
// other than the entry scheduled no reload, and the edit stayed invisible until
// someone `touch`ed the entry by hand — the "submodule changes need an entry
// touch" rule the extension guide documented. The reload itself always worked;
// what was broken was noticing there was something to reload.
//
// These cases drive the real loader over a real on-disk extension, because the
// bug lived in the seam between the graph walk and the watcher, and neither
// half reproduces it alone.

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writePackage(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-submodule-reload-"));
	tempRoots.push(dir);
	for (const rel in files) {
		const abs = path.join(dir, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, files[rel], "utf8");
	}
	return dir;
}

/** Entry re-exports its submodule's value, so the loaded module observable
 *  changes exactly when the submodule's bytes do. */
function splitExtension(label: string): Record<string, string> {
	return {
		"package.json": JSON.stringify({ name: "split-ext", version: "1.0.0" }),
		"panel.ts": `export const label = ${JSON.stringify(label)};\n`,
		"index.ts": [
			'import { label } from "./panel.ts";',
			"export const seen = label;",
			"export default function (pi) {",
			"\tvoid pi;",
			"}",
		].join("\n"),
	};
}

describe("extension source-graph change detection", () => {
	it("reports an entry for reload when only a submodule changed", async () => {
		const dir = await writePackage(splitExtension("v1"));
		const entry = path.join(dir, "index.ts");

		const before = (await loadLegacyPiModule(entry)) as { seen: string };
		expect(before.seen).toBe("v1");
		expect(extensionEntriesNeedingReload([entry])).toEqual([]);

		// The entry is never written again in this case — only its submodule is.
		await fs.writeFile(path.join(dir, "panel.ts"), 'export const label = "v2";\n', "utf8");

		expect(extensionEntriesNeedingReload([entry])).toEqual([entry]);

		// And the reload actually serves the new bytes, which is what makes the
		// touch unnecessary rather than merely unreported.
		const after = (await loadLegacyPiModule(entry)) as { seen: string };
		expect(after.seen).toBe("v2");
	});

	it("stops reporting an entry once its graph has been reloaded", async () => {
		const dir = await writePackage(splitExtension("v1"));
		const entry = path.join(dir, "index.ts");
		await loadLegacyPiModule(entry);

		await fs.writeFile(path.join(dir, "panel.ts"), 'export const label = "v2";\n', "utf8");
		expect(extensionEntriesNeedingReload([entry])).toEqual([entry]);

		// The baseline moves with the load, so a reload loop cannot form.
		await loadLegacyPiModule(entry);
		expect(extensionEntriesNeedingReload([entry])).toEqual([]);
	});

	it("reports an entry when a submodule is deleted", async () => {
		const dir = await writePackage(splitExtension("v1"));
		const entry = path.join(dir, "index.ts");
		await loadLegacyPiModule(entry);

		await fs.rm(path.join(dir, "panel.ts"));

		// The next load re-walks and re-resolves; that only happens if the
		// watcher was told.
		expect(extensionEntriesNeedingReload([entry])).toEqual([entry]);
	});
});
