import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import { mountPlugin } from "@musepi/pi-coding-agent/extensibility/plugins/runtime/mount";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

const CLAUDE_ENTRY = path.resolve(import.meta.dir, "../src/bundled-plugins/hooks-claude-code/index.ts");
const CODEX_ENTRY = path.resolve(import.meta.dir, "../src/bundled-plugins/hooks-codex/index.ts");

function hookCommand(script: string): string {
	const file = path.join(os.tmpdir(), `musepi-hook-${Math.random().toString(36).slice(2)}.js`);
	fs.writeFileSync(file, script);
	return `"${process.execPath}" "${file}"`;
}

describe("Claude Code command hook bridge", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@hooks-bridge-");
	});

	async function mountWith(config: {
		PreToolUse?: Array<{ matcher?: string; hooks: Array<{ type?: string; command: string }> }>;
		UserPromptSubmit?: Array<{ hooks: Array<{ command: string }> }>;
		Stop?: Array<{ hooks: Array<{ command: string }> }>;
	}) {
		const configPath = path.join(tempDir.path(), "hooks.json");
		fs.writeFileSync(configPath, JSON.stringify({ hooks: config }));
		const runtime = new ExtensionRuntime();
		const mounted = await mountPlugin({
			entryPath: CLAUDE_ENTRY,
			cwd: tempDir.path(),
			eventBus: new EventBus(),
			runtime,
			readConfig: async () => ({
				fields: [],
				values: { configPath, defaultTimeoutMs: 20_000 },
			}),
		});
		if (!mounted.ok) throw new Error(mounted.message);
		return new ExtensionRunner(
			[mounted.extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
		);
	}

	it("blocks a matching PreToolUse tool call with the hook's stderr", async () => {
		const runner = await mountWith({
			PreToolUse: [
				{
					matcher: "bash",
					hooks: [{ type: "command", command: hookCommand('console.error("no bash");process.exit(2)') }],
				},
			],
		});
		const result = (await runner.emit({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "ls" },
		} as never)) as { block?: boolean; reason?: string } | undefined;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no bash");
	});

	it("does not block a tool the matcher excludes", async () => {
		const runner = await mountWith({
			PreToolUse: [
				{
					matcher: "bash",
					hooks: [{ type: "command", command: hookCommand("process.exit(2)") }],
				},
			],
		});
		const result = await runner.emit({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "read",
			input: {},
		} as never);
		expect(result).toBeUndefined();
	});

	it("cancels a prompt refused by UserPromptSubmit", async () => {
		const runner = await mountWith({
			UserPromptSubmit: [{ hooks: [{ command: hookCommand('console.error("blocked prompt");process.exit(2)') }] }],
		});
		const result = await runner.emitBeforeAgentStart("hello", undefined, ["sys"]);
		expect(result).toMatchObject({ cancelled: true });
		expect(result?.reason).toContain("blocked prompt");
	});

	it("asks the settle to run once more when a Stop hook halts", async () => {
		const runner = await mountWith({
			Stop: [
				{
					hooks: [
						{
							command: hookCommand('console.log(JSON.stringify({continue:false,stopReason:"verify the fix"}))'),
						},
					],
				},
			],
		});
		const result = (await runner.emit({
			type: "session_stop",
			messages: [],
			turn_id: 1,
			session_id: "s1",
			stop_hook_active: false,
			signal: new AbortController().signal,
		} as never)) as { decision?: string; reason?: string } | undefined;
		expect(result).toMatchObject({ decision: "block" });
		expect(result?.reason).toContain("verify the fix");
	});
});

describe("Codex command hook bridge", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@hooks-codex-");
	});

	it("uses the Codex regex matcher mode for a PreToolUse block", async () => {
		const configPath = path.join(tempDir.path(), "hooks.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "^ba",
							hooks: [
								{ type: "command", command: hookCommand('console.error("codex says no");process.exit(2)') },
							],
						},
					],
				},
			}),
		);
		const runtime = new ExtensionRuntime();
		const mounted = await mountPlugin({
			entryPath: CODEX_ENTRY,
			cwd: tempDir.path(),
			eventBus: new EventBus(),
			runtime,
			readConfig: async () => ({ fields: [], values: { configPath, defaultTimeoutMs: 20_000 } }),
		});
		if (!mounted.ok) throw new Error(mounted.message);
		const runner = new ExtensionRunner(
			[mounted.extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
		);
		const result = (await runner.emit({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "ls" },
		} as never)) as { block?: boolean; reason?: string } | undefined;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("codex says no");
	});
});
