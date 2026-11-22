/**
 * Run the desktop package's tests from the repository root without dropping its
 * DOM preload.
 *
 * Why this exists: Bun reads `bunfig.toml` from the working directory, and
 * `apps/desktop/bunfig.toml` preloads the happy-dom shim that `react-dom`
 * caches its DOM feature detection from at import time. Running
 * `bun test apps/desktop/test/foo.test.tsx` from the root therefore loads no
 * shim at all, and the tests fail for a reason that has nothing to do with the
 * code: measured on one commit, `apps/desktop/test/agent-info-pane.test.tsx`
 * gave 21 pass / 0 fail from the package and 20 pass / 1 fail from the root.
 * Nothing in the root run says the preload was skipped, so the wrong answer
 * looks exactly like a real one.
 *
 * `bun run --cwd=apps/desktop test` changes the directory but does not forward
 * the arguments a caller adds, and `bun --cwd=... test` changes knip's view of
 * the workspace. So the wrapper does the one thing that is unambiguous: change
 * into the package, then hand `bun test` the arguments verbatim.
 *
 *   bun run test:desktop                     # the package's own `test` script
 *   bun run test:desktop agent-info-pane.test.tsx
 *   bun run test:desktop test/foo.test.tsx -t "one case"
 */
import { join } from "node:path";

const packageDir = join(import.meta.dir, "..", "apps", "desktop");
const forwarded = process.argv.slice(2);
const args = forwarded.length > 0 ? ["test", ...forwarded] : ["run", "test"];

const child = Bun.spawn(["bun", ...args], {
	cwd: packageDir,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await child.exited);
