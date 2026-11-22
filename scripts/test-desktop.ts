/**
 * Run the desktop package's tests from the repository root without dropping
 * either of the two things that make the package's own run correct.
 *
 * Why this exists: Bun reads `bunfig.toml` from the working directory, and
 * `apps/desktop/bunfig.toml` preloads the happy-dom shim that `react-dom`
 * caches its DOM feature detection from at import time. Running
 * `bun test apps/desktop/test/foo.test.tsx` from the root therefore loads no
 * shim at all, and the tests fail for a reason that has nothing to do with the
 * code: measured on one commit, `apps/desktop/test/agent-info-pane.test.tsx`
 * gave 21 pass / 0 fail from the package and 20 pass / 1 fail from the root.
 *
 * The package's `test` script carries two more flags, and a wrapper that
 * changes directory but then runs bare `bun test <args>` drops them — the same
 * "same commit, two verdicts" defect this mission exists to remove. On the
 * seven-file subset below, the argument path without them gave 7 failures and
 * with them 0, on one tree: `--isolate` gives each file its own happy-dom and
 * localStorage registry, so a shared registry reports cross-file failures that
 * do not exist when the files run as the package runs them.
 *
 * So the wrapper does not restate the flags. It reads the package's own `test`
 * script once, splits it, and appends whatever the caller passed — there is one
 * definition of "how the desktop tests run", and this cannot drift from it.
 * `bun run --cwd=apps/desktop test` would run that script but discards added
 * arguments, and `bun --cwd=... test` changes knip's view of the workspace.
 *
 *   bun run test:desktop                     # the package's own `test` script
 *   bun run test:desktop agent-info-pane.test.tsx
 *   bun run test:desktop test/foo.test.tsx -t "one case"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageDir = join(import.meta.dir, "..", "apps", "desktop");

/**
 * The package's `test` script, split into arguments, with the caller's appended.
 *
 * The script is `bun test --isolate --timeout=15000 test`: flags, then the
 * directory to search. Both halves matter, and they combine differently with a
 * caller's arguments. Appending `user-avatar.test.ts` after the script's `test`
 * directory makes Bun run the directory AND the file — the whole suite — so the
 * script's path is dropped as soon as the caller names its own targets, while
 * its flags always survive. That is the whole point: the caller narrows WHAT
 * runs, never HOW it runs.
 *
 * A script that is not a plain `bun test ...` invocation cannot be extended
 * safely — appending to a shell pipeline would change what it means — so this
 * fails loudly rather than silently running a different command than the
 * package does.
 */
export function commandFor(script: string, forwarded: readonly string[]): string[] {
	const tokens = script.trim().split(/\s+/);
	if (tokens[0] !== "bun" || tokens[1] !== "test") {
		throw new Error(`apps/desktop "test" is not a plain \`bun test\` invocation: ${JSON.stringify(script)}`);
	}
	// A shell operator or command substitution would change meaning when
	// arguments are appended to it.
	if (tokens.some(token => /^[&|;<>()`]|\$\(/.test(token))) {
		throw new Error(`apps/desktop "test" is not a plain \`bun test\` invocation: ${JSON.stringify(script)}`);
	}
	const rest = tokens.slice(2);
	const flags = rest.filter(token => token.startsWith("-"));
	const paths = rest.filter(token => !token.startsWith("-"));
	return ["test", ...flags, ...(forwarded.length > 0 ? forwarded : paths)];
}

if (import.meta.main) {
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};
	const script = manifest.scripts?.test;
	if (!script) throw new Error("apps/desktop/package.json has no `test` script");

	const child = Bun.spawn(["bun", ...commandFor(script, process.argv.slice(2))], {
		cwd: packageDir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await child.exited);
}
