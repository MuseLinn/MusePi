import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readPetPackage } from "../electron/pet-package.cjs";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(manifest: unknown): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "musepi-pet-package-"));
	dirs.push(dir);
	await writeFile(path.join(dir, "pet.json"), JSON.stringify(manifest));
	await writeFile(path.join(dir, "spritesheet.png"), new Uint8Array([137, 80, 78, 71]));
	await writeFile(path.join(dir, "spritesheet.webp"), new Uint8Array([82, 73, 70, 70]));
	return dir;
}

describe("pet package manifest import", () => {
	it("preserves Kimi name/spritesheet aliases, atlas states and bubble theme", async () => {
		const dir = await fixture({
			schemaVersion: 1,
			id: "kimi-musepi",
			name: "Kimi MusePi",
			description: "Gold orbital companion",
			spritesheet: "spritesheet.png",
			atlas: { frameWidth: 256, frameHeight: 288, rows: 8, columns: 8 },
			states: {
				idle: { row: 0, frames: 8, fps: 8, loop: true },
				celebrate: { row: 7, frames: 7, fps: 12, loop: false },
			},
			theme: { bubble: { background: "#5F6B62", foreground: "#FFFFFF", border: "#87928A" } },
		});
		const result = readPetPackage(dir, "Pet");
		expect(result).toMatchObject({
			id: "kimi-musepi",
			displayName: "Kimi MusePi",
			format: "atlas",
			atlas: { frameWidth: 256, frameHeight: 288, rows: 8, columns: 8 },
			states: {
				idle: { row: 0, frames: 8, fps: 8, loop: true },
				celebrate: { row: 7, frames: 7, fps: 12, loop: false },
			},
			theme: { bubble: { background: "#5F6B62", foreground: "#FFFFFF", border: "#87928A" } },
		});
		if ("error" in result) throw new Error(result.error);
		expect(result.spritesheet).toStartWith("data:image/png;base64,");
	});

	it("keeps the legacy Petdex manifest defaults", async () => {
		const dir = await fixture({ id: "old", displayName: "Old pet" });
		expect(readPetPackage(dir, "Pet")).toMatchObject({
			id: "old",
			displayName: "Old pet",
			format: "sheet",
		});
	});

	it("refuses a spritesheet path outside the unpacked package", async () => {
		const dir = await fixture({ id: "escape", spritesheet: "../outside.png" });
		expect(readPetPackage(dir, "Pet")).toEqual({ error: "invalid-spritesheet-path" });
	});

	it("rejects an invalid atlas instead of reinterpreting it as nine Petdex rows", async () => {
		const dir = await fixture({
			id: "bad-atlas",
			spritesheet: "spritesheet.png",
			atlas: { frameWidth: 256, frameHeight: 288, rows: 8, columns: 8 },
			states: { idle: { row: 8, frames: 8, fps: 8 } },
		});
		expect(readPetPackage(dir, "Pet")).toEqual({ error: "invalid-pet-atlas" });
	});
});
