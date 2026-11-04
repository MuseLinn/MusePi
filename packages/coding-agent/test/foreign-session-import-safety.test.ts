/**
 * Import safety: a foreign session is read and copied, never moved. The source
 * file must be byte-identical afterwards, and two imports must land in two
 * distinct MusePi session files (no overwrite of an earlier copy).
 *
 * Uses the real OMP store so the test exercises the same in-memory load path
 * production imports take.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistForeignSession } from "../src/session/foreign-session-import";
import type { ForeignSessionStore } from "../src/session/foreign-session-store";
import { SdkCompatSessionStore } from "../src/session/sdk-compat-session-store";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-import-safety-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function sourceSession(): Promise<{ file: string; store: ForeignSessionStore; id: string }> {
	const cwd = tempDir();
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "user", content: "hello from the source" } as never);
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "copied reply" }] } as never);
	const copy = await manager.persistCopy({ sessionDir: tempDir() });
	const written = copy.getSessionFile();
	await copy.close();
	if (!written) throw new Error("source session was not written");

	// SDK-compat layout: <root>/<encoded-cwd>/<id>.jsonl with a `.cwd` marker.
	const root = tempDir();
	const dir = path.join(root, "encoded");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "source-session.jsonl");
	fs.renameSync(written, file);
	fs.writeFileSync(path.join(dir, ".cwd"), cwd);

	return { file, store: new SdkCompatSessionStore("omp", [root]), id: "source-session" };
}

describe("foreign session import safety", () => {
	test("leaves the source file untouched and writes a distinct copy", async () => {
		const { file, store, id } = await sourceSession();
		const before = fs.readFileSync(file, "utf8");
		const [info] = await store.list();
		expect(info?.id).toBe(id);

		const imported = await persistForeignSession(store, info!, {
			sessionDir: tempDir(),
			suppressBreadcrumb: true,
		});
		const target = imported.getSessionFile();
		await imported.close();

		expect(fs.readFileSync(file, "utf8")).toBe(before);
		expect(target).toBeTruthy();
		expect(path.resolve(target!)).not.toBe(path.resolve(file));
		expect(fs.existsSync(target!)).toBe(true);
	});

	test("a second import creates a second file instead of overwriting the first", async () => {
		const { store, id } = await sourceSession();
		const [info] = await store.list();
		expect(info?.id).toBe(id);
		const targetDir = tempDir();

		const first = await persistForeignSession(store, info!, { sessionDir: targetDir });
		const firstFile = first.getSessionFile();
		await first.close();
		const second = await persistForeignSession(store, info!, { sessionDir: targetDir });
		const secondFile = second.getSessionFile();
		await second.close();

		expect(firstFile).toBeTruthy();
		expect(secondFile).toBeTruthy();
		expect(path.resolve(secondFile!)).not.toBe(path.resolve(firstFile!));
		expect(fs.existsSync(firstFile!)).toBe(true);
		expect(fs.existsSync(secondFile!)).toBe(true);
	});
});
