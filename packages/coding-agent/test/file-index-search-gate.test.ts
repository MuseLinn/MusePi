import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileIndexService } from "@musepi/pi-coding-agent/file-index/index";

/**
 * Contract: with the workspace index switched OFF (设置 → 索引库), searches
 * must report no matches even though FTS rows are still on disk — "索引关闭"
 * means the feature is dark, not that stale rows keep answering queries.
 * Clearing the data itself is a product decision and deliberately out of
 * scope (the gate blocks reads, not writes).
 */
describe("FileIndexService search enabled gate", () => {
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-file-index-gate-"));
		fs.writeFileSync(path.join(dir, "note.ts"), "export const hello = 'world marker';\n");
	});

	afterAll(async () => {
		// Windows + bun:sqlite: explicit prepare() handles outlive close()
		// until the finalizers run — force GC before removing the temp dir.
		Bun.gc(true);
		await Bun.sleep(100);
		Bun.gc(true);
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	});

	it("boots disabled, stays silent on search with rows in the FTS table, and hits once re-enabled", async () => {
		const index = new FileIndexService(path.join(dir, "file-index.db"));
		try {
			// Fresh db: idx_meta has no 'enabled' row → off (schema-consistent default).
			expect(index.enabled).toBe(false);

			// The scan itself is not gated (the settings page owns scan
			// triggering); it may still fill the FTS table. The contract
			// under test is that search refuses to answer while disabled.
			await index.scan(dir);
			expect(index.search("hello")).toEqual([]);

			index.setEnabled(true);
			const hits = index.search("hello");
			expect(hits.length).toBeGreaterThan(0);
			expect(hits[0]?.path.endsWith("note.ts")).toBe(true);
		} finally {
			index.close();
		}
	});
});
