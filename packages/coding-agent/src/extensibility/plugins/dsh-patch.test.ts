import { describe, expect, it } from "bun:test";
import { parseDshPatch } from "./dsh-patch";
import fixture from "./fixtures/dsh-sdk-minimal.patch.yml" with { type: "text" };

/**
 * A DSH patch file is YAML a Loader evaluates, marked with `!!js`. Two things
 * have to survive the trip through this host's parser, and both were observed
 * failing before they were handled:
 *
 * Bun drops an unknown tag and hands back the bare scalar, which would leave
 * `disabled: !!js process.platform === 'win32'` looking like the literal string
 * `"process.platform === 'win32'"`. A reader that could not tell those apart
 * would either evaluate a string it was given as data, or refuse every tagged
 * value including the ones it should have understood.
 *
 * The fixtures below are transcribed from real bundle files rather than written
 * to be easy, because the shapes that matter — a tagged scalar at the top level,
 * one nested in `config`, an untagged neighbour, a `group` row holding nested
 * rows — are the ones a hand-written example tends to omit.
 */
describe("parseDshPatch", () => {
	it("reads an insert list into rows with their ids and package names", () => {
		// Transcribed from the sdk-minimal bundle, reduced to three rows.
		const source = [
			"- insert:",
			"    - id: sdk-app-startup",
			"      name: '@deepseek-ai/dsh-sdk-app'",
			"      config:",
			"        profile: sdk-minimal",
			"",
			"    - id: sdk-jsonrpc-server",
			"      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
			"      inject: [sdkAppStartup, loader]",
			"      config:",
			"        maxTokensAsSuccess: false",
			"",
			"    - id: agent",
			"      name: '@deepseek-ai/dsh-agent'",
		].join("\n");

		const { rows } = parseDshPatch(source);

		expect(rows.map(r => r.id)).toEqual(["sdk-app-startup", "sdk-jsonrpc-server", "agent"]);
		expect(rows[0]?.name).toBe("@deepseek-ai/dsh-sdk-app");
		expect(rows[1]?.inject).toEqual(["sdkAppStartup", "loader"]);
		// An absent `disabled` is not a disabled row. The Loader treats absent as
		// enabled, so reading it as false would be a second meaning for the same
		// field depending on which reader looked.
		expect(rows[2]?.disabled).toBeUndefined();
		expect(rows[2]?.config).toBeUndefined();
	});

	it("keeps a tagged value tagged instead of evaluating or stringifying it", () => {
		// The two platform rows from the sdk-minimal bundle, one per platform.
		const source = [
			"- insert:",
			"    - id: terminal-bash",
			"      name: '@deepseek-ai/dsh-terminal-bash'",
			"      disabled: !!js process.platform === 'win32'",
			"      config:",
			"        timeoutMs: 300000",
			"",
			"    - id: terminal-pwsh",
			"      name: '@deepseek-ai/dsh-terminal-bash'",
			"      disabled: !!js process.platform !== 'win32'",
			"      config:",
			"        shellDialect: pwsh",
		].join("\n");

		const { rows } = parseDshPatch(source);

		// Tagged, with the expression intact and unevaluated. Evaluating here is
		// exactly what this host must not do with a file it merely installed.
		expect(rows[0]?.disabled).toEqual({ kind: "js-expr", expr: "process.platform === 'win32'" });
		expect(rows[1]?.disabled).toEqual({ kind: "js-expr", expr: "process.platform !== 'win32'" });
		// The same package appears twice, with opposite conditions — which is the
		// shape the whole conditional-enablement question comes from.
		expect(rows[0]?.name).toBe(rows[1]?.name);
	});

	it("keeps a tagged value inside config tagged", () => {
		// From the sdk-minimal bundle: `apiKeyEnv` and `defaultContextWindow` are
		// both tagged, and one of them reads an environment variable.
		const source = [
			"- insert:",
			"    - id: llm-deepseek",
			"      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
			"      config:",
			"        apiKeyEnv: DEEPSEEK_API_KEY",
			"        defaultContextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)",
			"        streamIdleTimeoutMs: 172800000",
		].join("\n");

		const { rows } = parseDshPatch(source);
		const config = rows[0]?.config as Record<string, unknown>;

		// An untagged neighbour stays a plain string — this is the discrimination
		// the whole marker scheme exists to preserve.
		expect(config.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
		expect(config.streamIdleTimeoutMs).toBe(172800000);
		expect(config.defaultContextWindow).toEqual({
			kind: "js-expr",
			expr: "Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)",
		});
	});

	it("does not mistake a tagged-looking line inside a block scalar for a tag", () => {
		// A plugin description can legitimately contain that text. Rewriting it
		// would corrupt a string the person wrote and hand the caller a value
		// nobody asked to be an expression.
		const source = [
			"- insert:",
			"    - id: persistent-bash",
			"      name: '@deepseek-ai/dsh-tool-bash-persistent'",
			"      config:",
			"        description: |-",
			"          Run commands in a bash shell",
			"          If you need !!js process.platform, do not write it",
		].join("\n");

		const { rows } = parseDshPatch(source);
		const config = rows[0]?.config as Record<string, unknown>;

		expect(typeof config.description).toBe("string");
		expect(config.description).toContain("!!js process.platform");
		expect((config.description as { kind?: string }).kind).toBeUndefined();
	});

	it("reports an id-targeted patch instead of guessing which row it meant", () => {
		// DSH's other forms override or disable a row an earlier layer created.
		// Resolving them needs the layer stack this host does not build, and
		// guessing would apply an override to whatever happened to share the id.
		const source = ["- id: agent", "  disabled: true", "- id: tools", "  name: '@deepseek-ai/dsh-tools'"].join("\n");

		const { rows, skipped } = parseDshPatch(source);

		expect(rows).toEqual([]);
		expect(skipped.map(s => s.reason)).toEqual(["id-targeted patch", "id-targeted patch"]);
		expect(skipped.map(s => s.droppedExpressions)).toEqual([0, 0]);
	});

	it("counts the tagged expressions a skipped id-targeted patch carried", () => {
		// The real headless bundle patches a row by id, and its config values are
		// all tagged — they read the loader context that provides the task. Those
		// expressions are dropped with the entry, and dropping them silently would
		// make a file whose non-insert half carried all of its dynamic
		// configuration parse "cleanly" while half of what it said was lost. The
		// count is the caller's way to say what was not taken.
		const source = [
			"- id: headless-runner",
			"  name: '@deepseek-ai/dsh-headless'",
			"  config:",
			"    task: !!js ctx.headlessStartup.task",
			"    sessionId: !!js ctx.headlessStartup.sessionId",
			"    json: !!js ctx.headlessStartup.json",
		].join("\n");

		const { rows, skipped } = parseDshPatch(source);

		expect(rows).toEqual([]);
		expect(skipped).toEqual([{ index: 0, reason: "id-targeted patch", droppedExpressions: 3 }]);
	});

	it("reads a group row without flattening the rows inside it", () => {
		// From the web-app preset: a group whose config is a list of rows. The
		// group is a row in its own right; its members are configuration this
		// host has no way to act on yet, and saying so beats pretending they are
		// top-level rows.
		const source = [
			"- insert:",
			"    - id: persistent-shell",
			"      name: cordis:group",
			"      group: true",
			"      isolate:",
			"        terminals: true",
			"      config:",
			"        - id: terminal-bash",
			"          name: '@deepseek-ai/dsh-terminal-bash'",
			"          disabled: !!js process.platform === 'win32'",
		].join("\n");

		const { rows } = parseDshPatch(source);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.group).toBe(true);
		expect(rows[0]?.name).toBe("cordis:group");
		// The member rows are inside the group's config, kept as parsed data.
		const members = rows[0]?.config as unknown[];
		expect(Array.isArray(members)).toBe(true);
		expect((members as { id: string }[])[0]?.id).toBe("terminal-bash");
	});

	it("rejects a file that is not a patch list at all", () => {
		// A corrupt file is a different thing from a shape this reader does not
		// handle, and saying which one it is saves the caller from guessing.
		expect(() => parseDshPatch("name: something\n")).toThrow(/list of patch entries/);
	});

	it("reads an empty file as no rows", () => {
		expect(parseDshPatch("")).toEqual({ rows: [], skipped: [] });
		expect(parseDshPatch("# just a comment\n")).toEqual({ rows: [], skipped: [] });
	});
});

/**
 * The transcribed cases above were written to cover shapes noticed while reading
 * real files, which means they cover the shapes that were noticed. This one is
 * an unmodified bundle patch, kept as a fixture so that a form nobody happened to
 * transcribe still has to parse — it did not, twice: a tagged value whose
 * expression contained its own quotes was left as a bare scalar with trailing
 * content, and the file stopped parsing at that line.
 */
describe("parseDshPatch on a real bundle patch", () => {
	it("reads every row of an unmodified DSH bundle patch", () => {
		const { rows, skipped } = parseDshPatch(fixture);

		expect(skipped).toEqual([]);
		expect(rows.length).toBe(32);
		// The file's four platform-conditional rows, kept as expressions. Each
		// appears twice — once per platform — over the same package, which is the
		// shape conditional enablement has to reproduce.
		const conditional = rows.filter(r => r.disabled !== undefined);
		expect(conditional.map(r => r.id).sort()).toEqual([
			"persistent-bash",
			"persistent-pwsh",
			"terminal-bash",
			"terminal-pwsh",
		]);
		for (const row of conditional) {
			expect(row.disabled).toMatchObject({
				kind: "js-expr",
				expr: expect.stringContaining("process.platform"),
			});
		}
	});

	it("keeps a multi-line description intact, including one that names a path", () => {
		const { rows } = parseDshPatch(fixture);
		const pwsh = rows.find(r => r.id === "persistent-pwsh");
		const config = pwsh?.config as Record<string, string>;

		// Block scalars are where a tag-looking token is content rather than a
		// tag, and this one carries a Windows path through a line of prose.
		expect(config.description).toContain("PowerShell");
		expect(config.description).toContain("C:\\");
		expect(config.description.split("\n").length).toBeGreaterThan(3);
		// A description that survived as a string, not an expression node.
		expect((config.description as unknown as { kind?: string }).kind).toBeUndefined();
	});

	it("keeps a tagged config value tagged next to its plain neighbours", () => {
		const { rows } = parseDshPatch(fixture);
		const config = rows.find(r => r.id === "llm-deepseek")?.config as Record<string, unknown>;

		expect(config.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
		expect(config.streamIdleTimeoutMs).toBe(172800000);
		expect(config.defaultContextWindow).toEqual({
			kind: "js-expr",
			expr: "Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)",
		});
	});
});
