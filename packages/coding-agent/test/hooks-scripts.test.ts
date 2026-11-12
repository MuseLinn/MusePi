import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@musepi/pi-utils";
import { commandForScript, scanScriptHookRoots } from "../src/extensibility/hooks/command/scripts";

describe("directory command hooks", () => {
	it("maps pre/post scripts to tool matchers in the shared config shape", async () => {
		const tempDir = TempDir.createSync("@hook-scripts-");
		try {
			fs.mkdirSync(path.join(tempDir.path(), "pre"), { recursive: true });
			fs.mkdirSync(path.join(tempDir.path(), "post"), { recursive: true });
			fs.writeFileSync(path.join(tempDir.path(), "pre", "bash.sh"), "exit 0\n");
			fs.writeFileSync(path.join(tempDir.path(), "pre", "all.sh"), "exit 0\n");
			fs.writeFileSync(path.join(tempDir.path(), "post", "edit.py"), "print('{}')\n");
			fs.writeFileSync(path.join(tempDir.path(), "pre", "notes.txt"), "not a hook\n");

			const { config, skipped } = await scanScriptHookRoots([tempDir.path()], {
				shell: "/bin/bash",
				python: "/usr/bin/python3",
			});
			expect(config.PreToolUse?.map(group => group.matcher)).toEqual([undefined, "bash"]);
			expect(config.PreToolUse?.[1]?.hooks[0]?.command).toContain("bash");
			expect(config.PostToolUse?.[0]?.matcher).toBe("edit");
			expect(config.PostToolUse?.[0]?.hooks[0]?.command).toContain("python3");
			expect(skipped).toEqual([{ event: "PreToolUse", reason: "unsupported script notes.txt" }]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("leaves Python disabled when no interpreter is configured", () => {
		expect(commandForScript("/x/hook.py", { shell: "bash" })).toBeNull();
		expect(commandForScript("/x/hook.sh", { shell: "bash" })).toBe("'bash' '/x/hook.sh'");
	});
});
