import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeDshBundle } from "./dsh-bundle";

/**
 * A bundle is a package that contributes rows to a loader tree rather than one
 * that registers a plugin itself. Reading that declaration is what lets an
 * install say "this package ships 12 rows, 4 of them name plugins you don't
 * have" instead of leaving the person to find out after installing.
 *
 * The fixture below is the real shape, copied from a shipped preset file: one
 * insert carrying a persona row, and a `cordis:group` whose members are nested
 * inside the group's own `config` array. That nesting is the case worth pinning
 * — a reader that only walks the top level reports a bundle with one row, and
 * the four shell rows it cannot see are exactly the ones that carry the
 * conditional this host will not evaluate.
 */
const MINIMAL_PRESET = `# Agent preset minimal: one declaration inserted after the web patch.
- insert:
    - id: preset-minimal
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: minimal
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a helpful software engineer assistant.
          - id: persistent-shell
            name: cordis:group
            group: true
            config:
              - id: pty
                name: '@deepseek-ai/dsh-terminal'
              - id: terminal-bash
                name: '@deepseek-ai/dsh-terminal-bash'
                disabled: !!js process.platform === 'win32'
                config:
                  timeoutMs: 300000
              - id: persistent-bash
                name: '@deepseek-ai/dsh-tool-bash-persistent'
                disabled: !!js process.platform === 'win32'
              - id: terminal-pwsh
                name: '@deepseek-ai/dsh-terminal-bash'
                disabled: !!js process.platform !== 'win32'
                config:
                  shellDialect: pwsh
`;

async function withBundleDir(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-dsh-bundle-"));
	try {
		for (const [name, contents] of Object.entries(files)) {
			await fs.writeFile(path.join(dir, name), contents, "utf8");
		}
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("dsh bundle inventory", () => {
	it("reports a package that declares no bundle as not one, without reading a patch file", async () => {
		await withBundleDir({ "package.json": JSON.stringify({ name: "plain-plugin" }) }, async dir => {
			const inventory = await describeDshBundle(dir);
			// The distinction that matters: absent is not "a bundle with no rows",
			// which would read as a broken install.
			expect(inventory.isBundle).toBe(false);
			expect(inventory.rows).toHaveLength(0);
			expect(inventory.patchFiles).toHaveLength(0);
		});
	});

	it("reads the patch file a manifest names", async () => {
		await withBundleDir(
			{
				"package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
				"cordis.patch.yml": MINIMAL_PRESET,
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				expect(inventory.isBundle).toBe(true);
				expect(inventory.patchFiles).toEqual(["./cordis.patch.yml"]);
				expect(inventory.rows.map(r => r.id)).toContain("preset-minimal");
				expect(inventory.rows[0]?.name).toBe("@deepseek-ai/dsh-agent-preset");
			},
		);
	});

	it("accepts a manifest listing several patch files, in the order given", async () => {
		// The list order is the composition order upstream, so sorting or
		// de-duplicating it here would report a bundle whose layers differ from
		// the one that ships.
		await withBundleDir(
			{
				"package.json": JSON.stringify({
					name: "multi",
					dsh: { bundle: { patch: ["./b.yml", "./a.yml"] } },
				}),
				"b.yml": "- insert:\n    - id: from-b\n      name: pkg-b\n",
				"a.yml": "- insert:\n    - id: from-a\n      name: pkg-a\n",
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				expect(inventory.patchFiles).toEqual(["./b.yml", "./a.yml"]);
				expect(inventory.rows.map(r => r.id)).toEqual(["from-b", "from-a"]);
			},
		);
	});

	it("keeps a conditional row's expression identifiable instead of reading it as a literal", async () => {
		// The failure this pins: `disabled: !!js process.platform === 'win32'`
		// and the same text written as a plain string are indistinguishable once
		// a YAML parser drops the unknown tag. An install report that treats
		// the row as unconditional says a Windows-incompatible shell is fine.
		await withBundleDir(
			{
				"package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./p.yml" } } }),
				"p.yml":
					"- insert:\n    - id: shell\n      name: pkg-shell\n      disabled: !!js process.platform === 'win32'\n",
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				const row = inventory.rows[0]!;
				expect(row.hasUnevaluatedExpression).toBe(true);
				expect(inventory.unevaluatedExpressions).toBe(1);
			},
		);
	});

	it("reports a row with no condition as unconditional", async () => {
		await withBundleDir(
			{
				"package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./p.yml" } } }),
				"p.yml": "- insert:\n    - id: plain\n      name: pkg-plain\n      disabled: false\n",
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				// `disabled: false` is a value, not an expression: present and false
				// is different from absent, and neither is something we run.
				expect(inventory.rows[0]?.hasUnevaluatedExpression).toBe(false);
				expect(inventory.unevaluatedExpressions).toBe(0);
			},
		);
	});

	it("lists a group's own members, not just the group that holds them", async () => {
		// The reason the real fixture matters: the preset ships one `cordis:group`
		// row whose `config` array holds four shell rows, and every one of those
		// carries a platform condition. A reader that walks only the top level
		// reports one row, names no package, and reports zero conditional
		// expressions — the install reads as "one harmless plugin".
		await withBundleDir(
			{
				"package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./p.yml" } } }),
				"p.yml": MINIMAL_PRESET,
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				const ids = inventory.rows.map(r => r.id);
				// The group keeps its own entry…
				expect(ids).toContain("persistent-shell");
				// …and its members are listed beside it.
				expect(ids).toContain("pty");
				expect(ids).toContain("terminal-bash");
				expect(ids).toContain("terminal-pwsh");
				// Three of the four members are platform-conditional — two are
				// Windows-incompatible and one is Unix-incompatible — which is
				// what makes the bundle conditional at all.
				const conditional = inventory.rows.filter(r => r.hasUnevaluatedExpression === true);
				expect(conditional.map(r => r.id).sort()).toEqual(["persistent-bash", "terminal-bash", "terminal-pwsh"]);
				// Counted once each. A group whose own config holds its members
				// would count every one of them again under the group.
				expect(inventory.unevaluatedExpressions).toBe(3);
			},
		);
	});

	it("resolves a nested member's package name, not only the group's", async () => {
		await withBundleDir(
			{
				"package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./p.yml" } } }),
				"p.yml": MINIMAL_PRESET,
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				const names = inventory.rows.map(r => r.name);
				// `cordis:group` is a Loader builtin and resolves to nothing here;
				// the members are the ones that name installable packages.
				expect(names).toContain("cordis:group");
				expect(names).toContain("@deepseek-ai/dsh-persona");
				expect(names).toContain("@deepseek-ai/dsh-terminal");
				for (const row of inventory.rows) {
					expect(row.resolution.status).toBe("not-installed");
				}
			},
		);
	});

	it("names a missing patch file rather than reporting a bundle with no rows", async () => {
		await withBundleDir(
			{ "package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./absent.yml" } } }) },
			async dir => {
				const inventory = await describeDshBundle(dir);
				// "Declares a bundle" and "contributed nothing" are different
				// failures and only one of them is the package's fault.
				expect(inventory.isBundle).toBe(true);
				expect(inventory.unreadable).toHaveLength(1);
				expect(inventory.unreadable[0]?.path).toBe("./absent.yml");
			},
		);
	});

	it("says every named plugin is missing when nothing is installed", async () => {
		// A bundle for another harness installs cleanly. The install report is
		// the only place that can say so before the person tries to use it.
		await withBundleDir(
			{
				"package.json": JSON.stringify({ name: "b", dsh: { bundle: { patch: "./p.yml" } } }),
				"p.yml": "- insert:\n    - id: row\n      name: '@deepseek-ai/dsh-agent-preset'\n",
			},
			async dir => {
				const inventory = await describeDshBundle(dir);
				expect(inventory.rows[0]?.resolution.status).toBe("not-installed");
			},
		);
	});

	it("treats an unreadable manifest as not a bundle", async () => {
		await withBundleDir({ "package.json": "{ not json" }, async dir => {
			const inventory = await describeDshBundle(dir);
			expect(inventory.isBundle).toBe(false);
		});
	});
});
