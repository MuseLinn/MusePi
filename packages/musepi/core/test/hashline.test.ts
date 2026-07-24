// MusePi core — hashline 引擎测试。
// 覆盖：锚定成功、漂移拒绝、recovery 成功/失败、多文件原子性、
// CRLF/BOM 还原、新 TAG 铸造、seen-line guard 开关、parser 边界。
import assert from "node:assert";
import { describe, it } from "node:test";
import { HashlineEngine } from "../src/hashline/engine.ts";
import { parsePatch } from "../src/hashline/parser.ts";
import { SnapshotStore } from "../src/hashline/store.ts";
import type { HashlineFs } from "../src/hashline/types.ts";

class MemFs implements HashlineFs {
	readonly files = new Map<string, string>();
	readonly written = new Map<string, string>();
	async readFile(p: string): Promise<string> {
		const content = this.files.get(p);
		if (content === undefined) throw new Error(`ENOENT: ${p}`);
		return content;
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(p, content);
		this.written.set(p, content);
	}
}

const FILE_A = ["line one", "line two", "line three", "line four", "line five"].join("\n");

function setup(initial: Record<string, string> = { "/a.txt": FILE_A }) {
	const fs = new MemFs();
	for (const [p, content] of Object.entries(initial)) fs.files.set(p, content);
	const store = new SnapshotStore();
	const engine = new HashlineEngine({ fs, store });
	return { fs, store, engine };
}

/** 模拟 read：记录快照并返回 tag。 */
function recordRead(store: SnapshotStore, path: string, text: string, seenLines?: Iterable<number>): string {
	return store.record(path, text, seenLines);
}

describe("parsePatch", () => {
	it("parses SWAP/DEL/INS hunks across sections", () => {
		const patch = parsePatch(
			["[/a.txt#AB12]", "SWAP 2:", "+replaced two", "DEL 4", "INS.POST 1:", "+after one", "[/b.txt#00FF]", "INS.HEAD:", "+top"].join(
				"\n",
			),
		);
		assert.strictEqual(patch.sections.length, 2);
		assert.strictEqual(patch.sections[0]!.tag, "AB12");
		// SWAP 2 → 1 replacement insert + 1 delete; DEL 4 → 1 delete; INS.POST → 1 insert
		assert.strictEqual(patch.sections[0]!.edits.length, 4);
		assert.strictEqual(patch.sections[1]!.edits.length, 1);
	});

	it("rejects `-old` body rows with an actionable message", () => {
		assert.throws(
			() => parsePatch("[/a.txt#AB12]\nSWAP 2:\n-line two\n+line 2"),
			/`-old` rows do not exist/,
		);
	});

	it("rejects SWAP with an empty body, pointing at DEL", () => {
		assert.throws(() => parsePatch("[/a.txt#AB12]\nSWAP 2.=" + "3:"), /use `DEL 2\.=3` instead/);
	});

	it("rejects content outside any hunk", () => {
		assert.throws(() => parsePatch("hello"), /content outside any hunk|No \[PATH#TAG\]/);
	});

	it("rejects overlapping delete anchors in one section", () => {
		assert.throws(
			() => parsePatch("[/a.txt#AB12]\nSWAP 1.=2:\n+x\nDEL 2"),
			/already targeted by another hunk/,
		);
	});

	it("accepts bare body rows with a warning", () => {
		const patch = parsePatch("[/a.txt#AB12]\nSWAP 2:\nno plus prefix");
		assert.strictEqual(patch.warnings.length, 1);
		assert.match(patch.warnings[0]!, /Prefix every body row/);
	});
});

describe("HashlineEngine — anchored apply", () => {
	it("applies a patch against a fresh snapshot and mints a new tag", async () => {
		const { fs, store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A, [1, 2, 3, 4, 5]);
		const result = await engine.applyPatch(`[/a.txt#${tag}]\nSWAP 2.=4:\n+middle`);
		assert.strictEqual(result.sections.length, 1);
		const section = result.sections[0]!;
		assert.strictEqual(section.recovered, false);
		assert.strictEqual(section.firstChangedLine, 2);
		assert.strictEqual(fs.files.get("/a.txt"), ["line one", "middle", "line five"].join("\n"));
		assert.ok(section.newTag.length === 4 && section.newTag !== tag, "minted a fresh tag");
		// 新 tag 已入库，可直接用于下一次编辑
		const again = await engine.applyPatch(`[/a.txt#${section.newTag}]\nDEL 1`);
		assert.strictEqual(fs.files.get("/a.txt"), ["middle", "line five"].join("\n"));
		assert.ok(again.sections[0]!.newTag !== section.newTag);
	});

	it("rejects a stale tag after the file changed underneath", async () => {
		const { fs, store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A);
		// 外部改动：改了锚定行本身的内容 → recovery 无法安全映射 → 拒绝
		fs.files.set("/a.txt", ["line one", "CHANGED two", "line three", "line four", "line five"].join("\n"));
		await assert.rejects(
			engine.applyPatch(`[/a.txt#${tag}]\nSWAP 2:\n+patched`),
			/Re-read the file with the read tool and retry with the new tag/,
		);
		assert.strictEqual(fs.written.size, 0, "拒绝时不写盘");
	});

	it("rejects an unknown tag and tells the model to read first", async () => {
		const { engine } = setup();
		await assert.rejects(engine.applyPatch("[/a.txt#DEAD]\nSWAP 1:\n+x"), /was not read in this session/);
	});

	it("inserts at bof/eof and around anchors", async () => {
		const { fs, store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A);
		await engine.applyPatch(
			[`[/a.txt#${tag}]`, "INS.HEAD:", "+header", "INS.POST 2:", "+after two", "INS.PRE 5:", "+before five", "INS.TAIL:", "+tail"].join("\n"),
		);
		assert.strictEqual(
			fs.files.get("/a.txt"),
			["header", "line one", "line two", "after two", "line three", "line four", "before five", "line five", "tail"].join(
				"\n",
			),
		);
	});

	it("rejects out-of-range anchors", async () => {
		const { store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A);
		await assert.rejects(engine.applyPatch(`[/a.txt#${tag}]\nSWAP 9:\n+x`), /out of range/);
	});
});

describe("HashlineEngine — recovery", () => {
	it("recovers when external edits shifted every anchor by one offset", async () => {
		const { fs, store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A);
		// 外部在头部插入两行 → 全部锚定行统一 +2 平移
		fs.files.set("/a.txt", ["new head 1", "new head 2", ...FILE_A.split("\n")].join("\n"));
		const result = await engine.applyPatch(`[/a.txt#${tag}]\nSWAP 2:\n+patched two`);
		const section = result.sections[0]!;
		assert.strictEqual(section.recovered, true);
		assert.match(section.warnings[0]!, /offset \+2/);
		assert.strictEqual(
			fs.files.get("/a.txt"),
			["new head 1", "new head 2", "line one", "patched two", "line three", "line four", "line five"].join("\n"),
		);
	});

	it("fails closed when the anchor line itself was edited", async () => {
		const { fs, store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A);
		fs.files.set("/a.txt", ["line one", "line two edited", "line three", "line four", "line five"].join("\n"));
		await assert.rejects(engine.applyPatch(`[/a.txt#${tag}]\nSWAP 2:\n+x`), /Re-read/);
	});

	it("fails closed on ambiguous anchors (duplicated lines, multiple offsets)", async () => {
		const content = ["}", "}", "}"].join("\n");
		const { fs, store, engine } = setup({ "/dup.txt": content });
		const tag = recordRead(store, "/dup.txt", content);
		// 外部删了第一行 → `}` 在新文本有两个位置，offset -1 与 0 均满足 → 歧义拒绝
		fs.files.set("/dup.txt", ["}", "}"].join("\n"));
		await assert.rejects(engine.applyPatch(`[/dup.txt#${tag}]\nSWAP 2:\n+x`), /Re-read/);
	});
});

describe("HashlineEngine — atomicity & encodings", () => {
	it("writes nothing when any section fails preflight", async () => {
		const b = ["b1", "b2"].join("\n");
		const { fs, store, engine } = setup({ "/a.txt": FILE_A, "/b.txt": b });
		const tagA = recordRead(store, "/a.txt", FILE_A);
		await assert.rejects(
			engine.applyPatch(`[/a.txt#${tagA}]\nSWAP 1:\n+a1-new\n[/b.txt#DEAD]\nSWAP 1:\n+b1-new`),
			/was not read in this session/,
		);
		assert.strictEqual(fs.files.get("/a.txt"), FILE_A, "第一段也不得落盘");
		assert.strictEqual(fs.written.size, 0);
	});

	it("restores CRLF line endings and BOM on write", async () => {
		const crlf = "α\r\nβ\r\nγ";
		const { fs, store, engine } = setup({ "/win.txt": `﻿${crlf}` });
		// 快照记录的是归一化文本（与 read 工具展示一致）
		const tag = recordRead(store, "/win.txt", "α\nβ\nγ");
		await engine.applyPatch(`[/win.txt#${tag}]\nSWAP 2:\n+B`);
		assert.strictEqual(fs.files.get("/win.txt"), "﻿α\r\nB\r\nγ");
	});

	it("dryRun applies in memory without writing or minting tags", async () => {
		const { fs, store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A);
		const result = await engine.applyPatch(`[/a.txt#${tag}]\nSWAP 1:\n+preview`, { dryRun: true });
		assert.strictEqual(fs.written.size, 0);
		assert.strictEqual(fs.files.get("/a.txt"), FILE_A);
		assert.strictEqual(result.sections[0]!.newTag, "");
		assert.strictEqual(result.sections[0]!.newText.split("\n")[0], "preview");
	});
});

describe("HashlineEngine — seen-line guard", () => {
	it("rejects edits on lines never displayed when enforced", async () => {
		const fs = new MemFs();
		fs.files.set("/a.txt", FILE_A);
		const store = new SnapshotStore();
		const engine = new HashlineEngine({ fs, store, enforceSeenLines: true });
		// 只展示了第 1-2 行
		const tag = recordRead(store, "/a.txt", FILE_A, [1, 2]);
		await assert.rejects(
			engine.applyPatch(`[/a.txt#${tag}]\nSWAP 4:\n+x`),
			/never displayed by read\/grep/,
		);
		// 展示的范围内可以编辑
		const ok = await engine.applyPatch(`[/a.txt#${tag}]\nSWAP 1:\n+one`);
		assert.strictEqual(ok.sections[0]!.recovered, false);
	});

	it("applies anywhere when the guard is off (default)", async () => {
		const { store, engine } = setup();
		const tag = recordRead(store, "/a.txt", FILE_A, [1, 2]);
		const result = await engine.applyPatch(`[/a.txt#${tag}]\nSWAP 4:\n+four`);
		assert.strictEqual(result.sections[0]!.recovered, false);
	});

	it("skips the guard when the snapshot has no provenance", async () => {
		const fs = new MemFs();
		fs.files.set("/a.txt", FILE_A);
		const store = new SnapshotStore();
		const engine = new HashlineEngine({ fs, store, enforceSeenLines: true });
		const tag = recordRead(store, "/a.txt", FILE_A); // 无 seenLines
		const result = await engine.applyPatch(`[/a.txt#${tag}]\nSWAP 4:\n+four`);
		assert.strictEqual(result.sections[0]!.recovered, false);
	});
});

describe("SnapshotStore", () => {
	it("dedups identical content onto one tag and merges seen lines", () => {
		const store = new SnapshotStore();
		const t1 = store.record("/a", FILE_A, [1]);
		const t2 = store.record("/a", FILE_A, [2]);
		assert.strictEqual(t1, t2);
		const snap = store.byHash("/a", t1)!;
		assert.deepStrictEqual([...snap.seenLines!].sort(), [1, 2]);
	});

	it("keeps distinct texts under colliding identity separate and resolves by content", () => {
		const store = new SnapshotStore();
		const v1 = store.record("/a", FILE_A);
		store.record("/a", "different content");
		const snap = store.byHash("/a", v1)!;
		assert.strictEqual(snap.text, FILE_A);
		assert.strictEqual(store.head("/a")!.text, "different content");
	});
});
