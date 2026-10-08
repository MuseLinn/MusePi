/**
 * Archive service contract: build-then-poll, and the two trust boundaries.
 *
 * The poll shape is not incidental — a build that held one RPC open for the
 * length of a large read is indistinguishable from a hung daemon, so these
 * tests check that `build` returns an id *before* anything is written, and that
 * the id is the only way to observe progress afterwards.
 *
 * Both trust decisions get their own case. The output fence matters because the
 * caller supplies a display name that becomes part of a filename; the collision
 * rule matters because two selected directories can each hold a `README.md` and
 * a zip with two entries of one name silently loses one of them.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { ArchiveService, sanitizeSuffix } from "../../src/daemon/services/archive-service";

async function setup(): Promise<{ service: ArchiveService; out: string; root: string }> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "archive-service-"));
	const out = path.join(root, "archives");
	const service = new ArchiveService({ archivesDir: () => out });
	return { service, out, root };
}

/** Poll until the build leaves `building`, or fail on timeout. */
async function settle(service: ArchiveService, id: string): Promise<Record<string, unknown>> {
	for (let i = 0; i < 200; i++) {
		const state = service.status({ id }) as Record<string, unknown>;
		if (state.state !== "building") return state;
		await Bun.sleep(10);
	}
	throw new Error("build never left the building state");
}

describe("ArchiveService.build", () => {
	test("returns an id and an entry count before writing anything", async () => {
		// The denominator has to be known up front or a progress bar has nothing
		// to divide by; and the file must not exist yet, because the RPC returns
		// before the copy starts.
		const { service, out, root } = await setup();
		try {
			fs.writeFileSync(path.join(root, "a.txt"), "A");
			const result = await service.build({ paths: [path.join(root, "a.txt")], name: "x" });
			expect("id" in result && result.id).toBeTruthy();
			expect(result).toMatchObject({ entries: 1 });
			expect(await fsp.readdir(out).catch(() => [])).toEqual([]);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("refuses an empty selection rather than building an empty archive", async () => {
		const { service, root } = await setup();
		try {
			// A zip of nothing is a valid file and a useless one. Refusing says
			// "you selected nothing", which is what actually happened.
			expect(await service.build({ paths: [] })).toEqual({ error: "paths required (empty selection)" });
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a selection whose files have all gone missing", async () => {
		const { service, root } = await setup();
		try {
			// Skipping unreadable entries is right *within* a selection; a
			// selection that yields nothing should say so rather than hand back a
			// zero-entry archive.
			const result = await service.build({ paths: [path.join(root, "never-existed.txt")] });
			expect(result).toEqual({ error: "selection contains no readable files" });
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("archives the readable part of a selection that lost a file", async () => {
		const { service, root } = await setup();
		try {
			const present = path.join(root, "here.txt");
			fs.writeFileSync(present, "kept");
			const result = await service.build({ paths: [present, path.join(root, "gone.txt")] });
			expect(result).toMatchObject({ entries: 1 });
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a third concurrent build for the same session", async () => {
		// Two is generous; a third means the client re-requests without reading
		// the first id, and honouring it means every request opens the same files.
		const { service, root } = await setup();
		try {
			for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x".repeat(2048));
			const paths = Array.from({ length: 40 }, (_, i) => path.join(root, `f${i}.txt`));
			const a = await service.build({ sessionId: "s", paths });
			const b = await service.build({ sessionId: "s", paths });
			expect("id" in a && "id" in b).toBe(true);
			const third = await service.build({ sessionId: "s", paths });
			expect(third).toMatchObject({ error: expect.stringContaining("builds running") });
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("does not count one session's builds against another's", async () => {
		const { service, root } = await setup();
		try {
			for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x".repeat(2048));
			const paths = Array.from({ length: 40 }, (_, i) => path.join(root, `f${i}.txt`));
			await service.build({ sessionId: "a", paths });
			await service.build({ sessionId: "a", paths });
			// A different session is a different person — the cap is per session
			// precisely so one busy panel cannot lock out another.
			expect(await service.build({ sessionId: "b", paths })).toMatchObject({ id: expect.any(String) });
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe("ArchiveService.status", () => {
	test("reports an unknown id as an error rather than an endless build", async () => {
		const { service, root } = await setup();
		try {
			// "building" for an id nobody started would strand a poller forever.
			expect(service.status({ id: "never-issued" })).toEqual({ error: "unknown or expired build" });
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("ends ready with a readable zip whose entries carry the file names", async () => {
		const { service, root } = await setup();
		try {
			fs.writeFileSync(path.join(root, "a.txt"), "hello");
			const { id } = (await service.build({ paths: [path.join(root, "a.txt")] })) as { id: string };
			const done = await settle(service, id);
			expect(done.state).toBe("ready");
			expect(done.total).toBe(1);
			expect(done.done).toBe(1);
			// Bytes are the uncompressed read, which is what a progress bar means
			// by "read so far" — the zip is smaller than that by design.
			expect(done.bytes).toBe(5);

			const zipPath = done.path as string;
			const entries = unzipSync(new Uint8Array(await Bun.file(zipPath).arrayBuffer()));
			expect(new TextDecoder().decode(entries["a.txt"])).toBe("hello");
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("archives a directory selection as a tree", async () => {
		const { service, root } = await setup();
		try {
			const dir = path.join(root, "src");
			fs.mkdirSync(path.join(dir, "deep"), { recursive: true });
			fs.writeFileSync(path.join(dir, "top.ts"), "TOP");
			// Two leaves share `deep/`: each one's parent would emit it, so this
			// is the case that proves a directory is written exactly once.
			fs.writeFileSync(path.join(dir, "deep", "nested.ts"), "NESTED");
			fs.writeFileSync(path.join(dir, "deep", "other.ts"), "OTHER");
			const { id } = (await service.build({ paths: [dir] })) as { id: string };
			const done = await settle(service, id);
			expect(done.state).toBe("ready");
			expect(done.total).toBe(3);

			const entries = unzipSync(new Uint8Array(await Bun.file(done.path as string).arrayBuffer()));
			// Names are relative to the selected directory, not absolute — an
			// archive carrying the creator's full disk layout is useless wherever
			// it lands. Leaves only here; the explicit directory entries are part
			// of a correct tree but do not answer "what did I select".
			const leaves = Object.keys(entries).filter(k => !k.endsWith("/"));
			expect(leaves.sort()).toEqual(["deep/nested.ts", "deep/other.ts", "top.ts"]);
			// The shared parent appears once. A directory emitted twice is a
			// malformed archive some readers reject outright.
			expect(Object.keys(entries).filter(k => k.endsWith("/"))).toEqual(["deep/"]);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("keeps both files when two selected directories hold one name", async () => {
		// A zip with two entries called README.md is not two files: readers pick
		// one, and the person never learns the other was there.
		const { service, root } = await setup();
		try {
			const a = path.join(root, "a");
			const b = path.join(root, "b");
			fs.mkdirSync(a, { recursive: true });
			fs.mkdirSync(b, { recursive: true });
			fs.writeFileSync(path.join(a, "README.md"), "FROM-A");
			fs.writeFileSync(path.join(b, "README.md"), "FROM-B");
			const { id } = (await service.build({ paths: [a, b] })) as { id: string };
			const done = await settle(service, id);
			expect(done.total).toBe(2);

			const entries = unzipSync(new Uint8Array(await Bun.file(done.path as string).arrayBuffer()));
			const values = Object.values(entries)
				.map(e => new TextDecoder().decode(e))
				.sort();
			expect(values).toEqual(["FROM-A", "FROM-B"]);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("reports a failed build as error with a reason", async () => {
		// The write is what can fail (a full disk, a locked path). The poller
		// needs the reason: "it didn't work" is not actionable, the path is.
		const { service, out, root } = await setup();
		try {
			fs.writeFileSync(path.join(root, "a.txt"), "A");
			// Point the output at a path that cannot be a directory, so writing
			// the zip fails after the build has started.
			fs.writeFileSync(out, "not a directory");
			const { id } = (await service.build({ paths: [path.join(root, "a.txt")] })) as { id: string };
			const done = await settle(service, id);
			expect(done.state).toBe("error");
			expect(done.error).toBeTruthy();
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe("sanitizeSuffix", () => {
	test("strips anything that could escape the service's directory", () => {
		// The name becomes part of a filename inside a directory this service
		// owns. `..` is the whole attack; separators are how it is spelled.
		expect(sanitizeSuffix("../../etc/passwd")).not.toContain("..");
		expect(sanitizeSuffix("..\\..\\windows")).not.toContain("..");
		expect(sanitizeSuffix("a/b")).not.toContain("/");
		expect(sanitizeSuffix("a\\b")).not.toContain("\\");
	});

	test("keeps a name a person would recognise in their downloads folder", () => {
		// Sanitising down to nothing would make every archive an opaque id, which
		// is worse than useful: the person has to find the file again later.
		expect(sanitizeSuffix("release-notes")).toBe("-release-notes");
		expect(sanitizeSuffix("发布说明")).toBe("-发布说明");
		expect(sanitizeSuffix("my notes")).toBe("-my-notes");
		expect(sanitizeSuffix(undefined)).toBe("");
		expect(sanitizeSuffix("///")).toBe("");
	});

	test("caps the length so a long name cannot push the extension away", () => {
		// An unbounded suffix would let a caller supply a megabyte-long name; the
		// `.zip` has to stay on the end for the file to open at all.
		expect(sanitizeSuffix("x".repeat(500))!.length).toBeLessThanOrEqual(41);
	});
});
