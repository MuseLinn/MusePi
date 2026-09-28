import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "@musepi/sdk";
import {
	deleteCreationTemplate,
	listCreationTemplates,
	PROJECT_METADATA_LIMIT_BYTES,
	readProjectMirror,
	saveCreationTemplate,
	validateProjectMetadata,
	writeProjectMirror,
} from "./creation";
import { ViewStore } from "./view-store";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "musepi-creation-"));
}

function snapshot(header: Record<string, unknown>): SessionSnapshot {
	return {
		header: {
			type: "session",
			id: header.id as string,
			timestamp: "2026-09-27T00:00:00.000Z",
			cwd: "/tmp",
			...header,
		},
		entries: [],
		state: {},
		agents: [],
		cursor: 0,
	} as unknown as SessionSnapshot;
}

const VALID_METADATA = {
	version: 1,
	kind: "prototype",
	name: "示例",
	fidelity: "high-fidelity",
};

describe("validateProjectMetadata (M3.2 §4 契约)", () => {
	it("accepts a well-formed metadata object", () => {
		expect(validateProjectMetadata(VALID_METADATA)).toEqual(VALID_METADATA);
	});

	it("rejects non-object payloads", () => {
		expect(() => validateProjectMetadata("nope")).toThrow(/must be a JSON object/);
		expect(() => validateProjectMetadata(null)).toThrow(/must be a JSON object/);
		expect(() => validateProjectMetadata([1, 2])).toThrow(/must be a JSON object/);
	});

	it("rejects metadata without a version (future migrations key on version)", () => {
		expect(() => validateProjectMetadata({ kind: "prototype" })).toThrow(/missing the required "version"/);
	});

	it("rejects unknown versions", () => {
		expect(() => validateProjectMetadata({ version: 2 })).toThrow(/unsupported project metadata version: 2/);
	});

	it("rejects payloads over the 16 KiB cap with a semantic message", () => {
		const big = { ...VALID_METADATA, filler: "x".repeat(PROJECT_METADATA_LIMIT_BYTES + 100) };
		try {
			validateProjectMetadata(big);
			throw new Error("expected validation to throw");
		} catch (err) {
			expect((err as Error).message).toMatch(/over the 16 KiB limit/);
			expect((err as Error).message).toMatch(/\b\d+ bytes\b/);
		}
	});

	it("accepts both asset-policy values, default key included (M3.7c §4)", () => {
		expect(validateProjectMetadata({ ...VALID_METADATA, assetPolicy: "ai-image" })).toEqual({
			...VALID_METADATA,
			assetPolicy: "ai-image",
		});
		expect(validateProjectMetadata({ ...VALID_METADATA, assetPolicy: "placeholder" })).toEqual({
			...VALID_METADATA,
			assetPolicy: "placeholder",
		});
		// 缺键保持放行（可选项语义,与 designSystemId 同一条路）。
		expect(validateProjectMetadata({ ...VALID_METADATA })).toEqual(VALID_METADATA);
	});

	it("rejects an unknown assetPolicy value fail-fast with a semantic message", () => {
		expect(() => validateProjectMetadata({ ...VALID_METADATA, assetPolicy: "stock" })).toThrow(
			/invalid asset policy: "stock" \(expected "ai-image" or "placeholder"\)/,
		);
		expect(() => validateProjectMetadata({ ...VALID_METADATA, assetPolicy: null })).toThrow(/invalid asset policy/);
	});
});

describe("creation template store", () => {
	it("saves, lists (newest first), and roundtrips a template", async () => {
		const dir = tmpDir();
		const first = await saveCreationTemplate({ tab: "prototype", metadata: VALID_METADATA, name: "一" }, dir);
		await Bun.sleep(5);
		const second = await saveCreationTemplate({ tab: "deck", metadata: { version: 1, kind: "deck" } }, dir);
		const list = await listCreationTemplates(dir);
		expect(list.map(t => t.id)).toEqual([second.id, first.id]);
		expect(list[1]).toMatchObject({ name: "一", tab: "prototype", version: 1 });
	});

	it("upserts by id: metadata replaced, createdAt preserved, updatedAt bumped", async () => {
		const dir = tmpDir();
		const a = await saveCreationTemplate({ tab: "prototype", metadata: VALID_METADATA }, dir);
		await Bun.sleep(5);
		const b = await saveCreationTemplate(
			{ id: a.id, tab: "prototype", metadata: { version: 1, kind: "other" } },
			dir,
		);
		expect(b.id).toBe(a.id);
		expect(b.createdAt).toBe(a.createdAt);
		expect(b.updatedAt >= a.updatedAt).toBe(true);
		expect((await listCreationTemplates(dir)).length).toBe(1);
	});

	it("skips corrupt files instead of failing the list", async () => {
		const dir = tmpDir();
		await saveCreationTemplate({ tab: "media", metadata: VALID_METADATA }, dir);
		await Bun.write(join(dir, "broken.json"), "{not json");
		const list = await listCreationTemplates(dir);
		expect(list.length).toBe(1);
	});

	it("delete is idempotent and rejects path-traversal ids", async () => {
		const dir = tmpDir();
		const t = await saveCreationTemplate({ tab: "other", metadata: VALID_METADATA }, dir);
		expect(await deleteCreationTemplate(t.id, dir)).toBe(true);
		expect(await deleteCreationTemplate(t.id, dir)).toBe(false);
		expect(await listCreationTemplates(dir)).toEqual([]);
		expect(deleteCreationTemplate("../escape", dir)).rejects.toThrow(/invalid creation template id/);
	});

	it("save re-validates metadata (16 KiB cap holds for templates too)", async () => {
		const dir = tmpDir();
		expect(
			saveCreationTemplate(
				{ tab: "prototype", metadata: { version: 1, filler: "x".repeat(PROJECT_METADATA_LIMIT_BYTES + 1) } },
				dir,
			),
		).rejects.toThrow(/over the 16 KiB limit/);
	});
});

describe(".musepi/project.json mirror", () => {
	it("roundtrips and returns null when absent", async () => {
		const cwd = tmpDir();
		expect(await readProjectMirror(cwd)).toBeNull();
		await writeProjectMirror(cwd, VALID_METADATA);
		expect(await readProjectMirror(cwd)).toEqual(VALID_METADATA);
	});
});

describe("ViewStore project_metadata preservation (modeId 同款保留语义)", () => {
	it("persists creation metadata through the header and survives metadata-less re-persists", () => {
		const store = new ViewStore(join(tmpDir(), "views.db"));
		store.upsert("s1", snapshot({ id: "s1", projectMetadata: VALID_METADATA }), null);
		// load() 路径（恢复/reactivation 读回）。
		expect(store.load("s1")?.header.projectMetadata).toEqual(VALID_METADATA);
		// 模拟 live schedulePersist:视图重建的快照头不带该 key,必须回注。
		store.upsert("s1", snapshot({ id: "s1" }), null);
		expect(store.load("s1")?.header.projectMetadata).toEqual(VALID_METADATA);
		expect(store.list().find(r => r.sessionId === "s1")?.projectMetadata).toEqual(VALID_METADATA);
	});

	it("replaces when an explicit new value arrives and stays null for plain sessions", () => {
		const store = new ViewStore(join(tmpDir(), "views.db"));
		store.upsert("plain", snapshot({ id: "plain" }), null);
		store.upsert("plain", snapshot({ id: "plain" }), null);
		expect(store.load("plain")?.header.projectMetadata).toBeUndefined();
		expect(store.list().find(r => r.sessionId === "plain")?.projectMetadata).toBeNull();

		const updated = { version: 1, kind: "template", templateId: "tpl-x" };
		store.upsert("s2", snapshot({ id: "s2", projectMetadata: VALID_METADATA }), null);
		store.upsert("s2", snapshot({ id: "s2", projectMetadata: updated }), null);
		store.upsert("s2", snapshot({ id: "s2" }), null);
		expect(store.load("s2")?.header.projectMetadata).toEqual(updated);
	});
});
