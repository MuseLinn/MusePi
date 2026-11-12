import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@musepi/pi-utils";
import { parseHookOutput } from "../src/extensibility/hooks/command/codec";
import { parseHookConfig } from "../src/extensibility/hooks/command/config";
import { runHookPoint } from "../src/extensibility/hooks/command/engine";
import { matchesMatcher, selectHookGroups } from "../src/extensibility/hooks/command/matcher";
import { mergeHookOutputs } from "../src/extensibility/hooks/command/merge";

describe("command hook matcher", () => {
	it("treats absent, empty and * as match-all", () => {
		for (const matcher of [undefined, "", "*"]) {
			expect(matchesMatcher(matcher, "bash", "claude-code")).toBe(true);
			expect(matchesMatcher(matcher, "anything", "codex")).toBe(true);
		}
	});

	it("reads Claude word/pipe patterns as literal alternatives and others as regex", () => {
		expect(matchesMatcher("bash|edit", "edit", "claude-code")).toBe(true);
		expect(matchesMatcher("bash|edit", "read", "claude-code")).toBe(false);
		expect(matchesMatcher("^ba", "bash", "claude-code")).toBe(true);
		// Codex interprets even a word/pipe pattern as an unanchored regex.
		expect(matchesMatcher("bash|edit", "edit", "codex")).toBe(true);
		expect(matchesMatcher("^ba", "bash", "codex")).toBe(true);
	});

	it("selects only matching groups that carry commands", () => {
		const groups = [
			{ matcher: "bash", hooks: [{ command: "a" }] },
			{ matcher: "read", hooks: [{ command: "b" }] },
			{ matcher: "bash", hooks: [] },
		];
		expect(selectHookGroups(groups, "bash", "claude-code")).toEqual([groups[0]!]);
	});
});

describe("command hook config parsing", () => {
	it("parses a Claude settings wrapper and applies substitutions", () => {
		const { config, skipped } = parseHookConfig(
			{
				hooks: {
					PreToolUse: [
						{ matcher: "bash", hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/guard.sh" }] },
					],
					SessionStart: [{ hooks: [{ type: "prompt", prompt: "x" }] }],
				},
			},
			"claude-code",
			{ projectDir: "/repo" },
		);
		expect(config.PreToolUse?.[0]?.hooks[0]?.command).toBe("/repo/guard.sh");
		expect(skipped).toEqual([{ event: "SessionStart", reason: 'unsupported "prompt" hook' }]);
	});

	it("drops matcher fields on events without a subject and rejects an invalid regex", () => {
		const { config } = parseHookConfig(
			{ UserPromptSubmit: [{ matcher: "bash", hooks: [{ command: "a" }] }] },
			"claude-code",
		);
		expect(config.UserPromptSubmit?.[0]?.matcher).toBeUndefined();
		expect(() =>
			parseHookConfig({ PreToolUse: [{ matcher: "[", hooks: [{ command: "a" }] }] }, "claude-code"),
		).toThrow("invalid claude-code regex");
	});

	it("skips async Codex hooks and keeps single-command groups", () => {
		const { config, skipped } = parseHookConfig(
			{ PreToolUse: [{ matcher: "bash", hooks: [{ command: "a" }, { command: "b", async: true }] }] },
			"codex",
		);
		expect(config.PreToolUse?.[0]?.hooks).toEqual([{ command: "a" }]);
		expect(skipped).toEqual([{ event: "PreToolUse", reason: "async hook" }]);
	});
});

describe("command hook codec and merge", () => {
	it("blocks on exit 2 with stderr as the reason", () => {
		expect(parseHookOutput(2, "", "no writes")).toMatchObject({ decision: "block", reason: "no writes" });
	});

	it("reads structured context only from a clean exit and guards the event name", () => {
		const stdout = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				additionalContext: "ctx",
			},
		});
		expect(parseHookOutput(0, stdout, "", "PreToolUse")).toMatchObject({
			decision: "deny",
			additionalContext: "ctx",
		});
		expect(parseHookOutput(0, stdout, "", "PostToolUse").additionalContext).toBeUndefined();
	});

	it("merges deny > ask > allow, keeps the winning reason and accumulates context", () => {
		const merged = mergeHookOutputs([
			{ exitCode: 0, stderr: "", stdout: "", decision: "allow", reason: "ok" },
			{ exitCode: 0, stderr: "", stdout: "", decision: "deny", reason: "no" },
			{ exitCode: 0, stderr: "", stdout: "", decision: "ask", reason: "sure?" },
			{ exitCode: 0, stderr: "", stdout: "", additionalContext: "a", systemMessage: "w" },
		]);
		expect(merged.decision).toBe("deny");
		expect(merged.reason).toBe("no");
		expect(merged.additionalContext).toEqual(["a"]);
		expect(merged.systemMessages).toEqual(["w"]);
	});
});

describe("command hook engine", () => {
	it("runs matched hooks serially through the shell and merges their exit codes", async () => {
		const tempDir = TempDir.createSync("@hook-command-");
		try {
			const block = path.join(tempDir.path(), "block.js");
			const context = path.join(tempDir.path(), "context.js");
			fs.writeFileSync(block, `console.error("blocked by policy"); process.exit(2);`);
			fs.writeFileSync(
				context,
				`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"saw "+p.tool_name}}));});`,
			);
			const command = (file: string): string => `"${process.execPath}" "${file}"`;
			const { config } = parseHookConfig(
				{
					PreToolUse: [
						{ matcher: "bash", hooks: [{ command: command(context) }] },
						{ matcher: "bash", hooks: [{ command: command(block) }] },
					],
				},
				"codex",
			);
			const result = await runHookPoint(
				config,
				"codex",
				"PreToolUse",
				"bash",
				{ tool_name: "bash" },
				{
					cwd: tempDir.path(),
					shell: process.env.SHELL || (process.platform === "win32" ? "bash" : "/bin/sh"),
					defaultTimeoutMs: 20_000,
				},
			);
			expect(result.merged.decision).toBe("deny");
			expect(result.merged.reason).toContain("blocked by policy");
			expect(result.merged.additionalContext).toEqual(["saw bash"]);
		} finally {
			tempDir.removeSync();
		}
	});
});
