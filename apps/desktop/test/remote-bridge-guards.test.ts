/**
 * The main-process IPC guards that a renderer can reach.
 *
 * These live in `electron/main.cjs`, which needs Electron to load, so the
 * validators are tested through a small extraction of the same logic. What is
 * pinned is the rule the review found inconsistent: every name that reaches
 * `docker` as an argv element is refused when it looks like an option, exactly
 * as a destination and a distribution already are.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mainSource = readFileSync(join(import.meta.dir, "..", "electron", "main.cjs"), "utf8");

/**
 * The `cliName` guard, evaluated from the real source so the test cannot drift
 * from the file it is asserting about.
 */
const cliName: (value: unknown, max?: number) => string | null = (() => {
	const match = /function cliName\(value, max = 256\) \{([\s\S]*?)\n\}/.exec(mainSource);
	if (!match) throw new Error("cliName not found in main.cjs");
	// The default lives in the parameter list, which `new Function` does not
	// carry over, so it is applied here instead.
	const fn = new Function("value", "max", match[1]) as (value: unknown, max: number) => string | null;
	return (value, max = 256) => fn(value, max);
})();

describe("docker argv name guard", () => {
	test("a name beginning with a dash is refused, like a destination or a distro", () => {
		// `docker exec -v ...` would be read as an option, not a container.
		expect(cliName("-v")).toBeNull();
		expect(cliName("--privileged")).toBeNull();
		expect(cliName("  -it  ")).toBeNull();
	});

	test("an ordinary name passes", () => {
		expect(cliName("musepi-dev")).toBe("musepi-dev");
		expect(cliName("  ghcr.io/me/musepi:latest  ")).toBe("ghcr.io/me/musepi:latest");
	});

	test("an empty or non-string value is refused, and an overlong one too", () => {
		expect(cliName("")).toBeNull();
		expect(cliName("   ")).toBeNull();
		expect(cliName(undefined)).toBeNull();
		expect(cliName(42)).toBeNull();
		expect(cliName("a".repeat(257))).toBeNull();
		expect(cliName("a".repeat(256))).toBe("a".repeat(256));
	});

	test("every docker handler routes its names through the guard", () => {
		// A handler that forgets the guard would accept `--privileged`; the
		// assertion is on the source so a new handler cannot slip past.
		const run = /ipcMain\.handle\("remote-docker-run"[\s\S]*?\n\}\);/.exec(mainSource)?.[0] ?? "";
		const exec = /ipcMain\.handle\("remote-docker-exec"[\s\S]*?\n\}\);/.exec(mainSource)?.[0] ?? "";
		expect(run).toContain("cliName(input.name)");
		expect(run).toContain("cliName(input.image)");
		expect(exec).toContain("cliName(input.container)");
	});
});

/**
 * The MusePi reader, evaluated from the real source.
 *
 * `readMusepiSshHosts` reads the same file `remote.hosts` reads, and it is the
 * only place a `proxyJump` in `ssh.json` becomes a catalog field. A reader that
 * skips it makes a MusePi-registered bastion-only host dial its destination
 * directly, so the mapping is asserted here rather than inferred from the
 * loader test above.
 */
describe("readMusepiSshHosts mapping", () => {
	const readMusepiSshHosts: (deps: {
		path: { join: (...parts: string[]) => string };
		fs: { readFileSync: () => string };
		currentDataRoot: () => string;
	}) => Array<Record<string, unknown>> = (() => {
		const match = /\nfunction readMusepiSshHosts\(\) \{([\s\S]*?)\n\}\n/.exec(mainSource);
		if (!match) throw new Error("readMusepiSshHosts not found in main.cjs");
		// The extracted body reads the three dependencies as free variables, so
		// they are passed positionally and the object wrapper is applied here.
		const fn = new Function("path", "fs", "currentDataRoot", match[1]) as (
			p: unknown,
			f: unknown,
			root: unknown,
		) => Array<Record<string, unknown>>;
		return deps => fn(deps.path, deps.fs, deps.currentDataRoot);
	})();

	const read = (hosts: Record<string, unknown>): Array<Record<string, unknown>> =>
		readMusepiSshHosts({
			path: { join: (...parts) => parts.join("/") },
			fs: { readFileSync: () => JSON.stringify({ hosts }) },
			currentDataRoot: () => "/data",
		});

	test("a chain in ssh.json becomes a catalog field", () => {
		const rows = read({ internal: { host: "10.0.0.5", username: "me", proxyJump: "bastion" } });
		expect(rows).toEqual([{ name: "internal", host: "10.0.0.5", username: "me", proxyJump: "bastion" }]);
	});

	test("a host without a chain has no proxyJump field", () => {
		const rows = read({ direct: { host: "h.example.com" } });
		expect(rows[0]).not.toHaveProperty("proxyJump");
	});

	test("the reader targets the file the daemon writes", () => {
		const joined: string[][] = [];
		readMusepiSshHosts({
			path: {
				join: (...parts) => {
					joined.push(parts);
					return parts.join("/");
				},
			},
			fs: { readFileSync: () => JSON.stringify({ hosts: {} }) },
			currentDataRoot: () => "/data",
		});
		expect(joined[0]).toEqual(["/data", "agent", "ssh.json"]);
	});
});
