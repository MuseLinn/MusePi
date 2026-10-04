/**
 * `check-comment-provenance` contract tests.
 *
 * The gate only earns a place in `bun run check` if it separates the two kinds
 * of reference correctly and if its baseline behaves in both directions: new
 * annotations fail, cleanup never does. Each case below names the failure it
 * prevents.
 */
import { describe, expect, test } from "bun:test";
import { collectHits, countByFile } from "./check-comment-provenance";

const read =
	(map: Record<string, string>) =>
	(file: string): string => {
		const body = map[file];
		if (body === undefined) throw new Error(`no such file: ${file}`);
		return body;
	};

describe("collectHits", () => {
	test("flags a comment that names an upstream project", () => {
		const hits = collectHits(["a.ts"], read({ "a.ts": "// openchamber parity: the rail opens content\n" }));
		// Failure mode if regressed: the convention stops holding, and new
		// comments keep naming where an idea came from instead of what it does.
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(1);
	});

	test("flags the capitalised spellings the codebase actually uses", () => {
		const hits = collectHits(
			["a.ts"],
			read({
				"a.ts": "/** Panel collapse (ZCode-style): fold to thin rails. */\n",
			}),
		);
		// Measured on this repository: 179 of the annotated lines spell the name
		// as `Openchamber` or `ZCode`. A case-sensitive token list would have
		// missed them and let the gate pass while half the comments qualified.
		expect(hits).toHaveLength(1);
	});

	test("leaves cross-surface consistency notes alone", () => {
		const source = [
			"/** TUI parity: the gate keeps the bare-Escape shortcut working. */",
			"/** client-core parity is guarded by the i18n tests. */",
			"// Matches the desktop host's right-edge alignment.",
			"",
		].join("\n");
		// These are real contracts between our own surfaces, not provenance. A
		// gate that flagged them would force us to delete the reason those
		// surfaces stay in step.
		expect(collectHits(["a.ts"], read({ "a.ts": source }))).toHaveLength(0);
	});

	test("leaves our own provider id and wire header alone", () => {
		const source = [
			"// The kimi-code provider is polled when getApiKey() is called.",
			"// Requests need x-opencode-session or they cannot be routed.",
			"// The kimi-code/k3 SKU carries the model namespace prefix.",
			"",
		].join("\n");
		// All three are product vocabulary — our provider id and a protocol
		// header. Matching them would flood the report and train everyone to
		// ignore the gate.
		expect(collectHits(["a.ts"], read({ "a.ts": source }))).toHaveLength(0);
	});

	test("judges whole-line comments only", () => {
		const source = 'const tokenUrl = "https://zcode.z.ai/api/v1/oauth/token";\n';
		// A code line may legitimately contain a URL with one of these names in
		// it. Measured on this repository, that is the only occurrence of the
		// shape, so scanning past the comment marker would add a false positive
		// and no real coverage.
		expect(collectHits(["a.ts"], read({ "a.ts": source }))).toHaveLength(0);
	});

	test("flags a JSX comment, which opens with a brace", () => {
		const source = ["return (", "\t{/* openchamber ContextPanelRail: tool icons */}", ");", ""].join("\n");
		// Failure mode if regressed: the gate silently stops seeing every JSX
		// comment, so the GUI's .tsx files look clean while carrying annotations.
		expect(collectHits(["a.tsx"], read({ "a.tsx": source }))).toHaveLength(1);
	});

	test("matches whole tokens, not substrings", () => {
		const source = "// The zcodes buffer and the dshift helper are ours.\n";
		// A loose pattern would rewrite unrelated identifiers.
		expect(collectHits(["a.ts"], read({ "a.ts": source }))).toHaveLength(0);
	});
});

describe("countByFile", () => {
	test("counts one entry per annotated line, not per token", () => {
		const hits = collectHits(
			["a.ts", "b.ts"],
			read({
				"a.ts": "// openchamber parity\n// dsh semantics\n",
				"b.ts": "// ZCode-style layout\n",
			}),
		);
		// The baseline is per file; a line naming two projects must not inflate
		// the count, or cleaning one name off a line would read as growth.
		expect(countByFile(hits)).toEqual({ "a.ts": 2, "b.ts": 1 });
	});
});
