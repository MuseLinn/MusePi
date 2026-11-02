import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { createClaudeCodeExecutor } from "@musepi/pi-coding-agent/bundled-plugins/subagent-claude-code/index";
import { createCodeBuddyExecutor } from "@musepi/pi-coding-agent/bundled-plugins/subagent-codebuddy/index";
import { createCodexExecutor } from "@musepi/pi-coding-agent/bundled-plugins/subagent-codex/index";
import { createKimiCodeExecutor } from "@musepi/pi-coding-agent/bundled-plugins/subagent-kimi-code/index";
import { createOpenCodeExecutor } from "@musepi/pi-coding-agent/bundled-plugins/subagent-opencode/index";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ExecutorOptions } from "@musepi/pi-coding-agent/task/executor";
import { runExternalSubagent } from "@musepi/pi-coding-agent/task/external";
import type { ExternalProcessFactory } from "@musepi/pi-coding-agent/task/external-cli";
import type { AgentDefinition, ExternalSubagentExecutor } from "@musepi/pi-coding-agent/task/types";
import { spawn } from "@musepi/pi-utils/ptree";

const fixture = path.join(import.meta.dir, "../fixtures/external-product-cli.ts");

function fakeProcess(product: string, commands: string[][]): ExternalProcessFactory {
	return (command, options) => {
		commands.push(command);
		return spawn([process.execPath, fixture, ...command.slice(1)], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_PRODUCT: product },
			stdin: options.stdin,
			signal: options.signal,
		});
	};
}

function options(external: ExternalSubagentExecutor, signal?: AbortSignal): ExecutorOptions {
	const agent: AgentDefinition = {
		name: "external-product",
		description: "External product test",
		systemPrompt: "",
		source: "extension",
		external,
	};
	return {
		cwd: os.tmpdir(),
		agent,
		task: "Solve the task",
		assignment: "Solve the task",
		context: "Shared batch context",
		index: 0,
		id: "ExternalProduct",
		settings: Settings.isolated({}),
		maxRuntimeMs: 0,
		signal,
	};
}

const cases = [
	{ product: "codex", answer: "codex answer", factory: createCodexExecutor, flag: "app-server" },
	{ product: "claude", answer: "claude answer", factory: createClaudeCodeExecutor, flag: "--output-format" },
	{ product: "codebuddy", answer: "codebuddy answer", factory: createCodeBuddyExecutor, flag: "--output-format" },
	{ product: "kimi", answer: "kimi answer", factory: createKimiCodeExecutor, flag: "--output-format" },
	{ product: "opencode", answer: "opencode answer", factory: createOpenCodeExecutor, flag: "--format" },
] as const;

describe("external product adapters", () => {
	for (const testCase of cases) {
		it(`runs ${testCase.product} through a real protocol process`, async () => {
			const commands: string[][] = [];
			const capturePath = path.join(os.tmpdir(), `musepi-codex-${process.pid}-${Date.now()}.jsonl`);
			const config = {
				model: "native/test-model",
				...(testCase.product === "codex" ? { env: JSON.stringify({ FAKE_CAPTURE: capturePath }) } : {}),
			};
			try {
				const external = testCase.factory(config, fakeProcess(testCase.product, commands));
				const result = await runExternalSubagent(options(external));
				expect(result).toMatchObject({ exitCode: 0, output: testCase.answer, aborted: false });
				expect(commands).toHaveLength(1);
				expect(commands[0]).toContain(testCase.flag);
				if (testCase.product === "codex") {
					const messages = fs
						.readFileSync(capturePath, "utf8")
						.trim()
						.split("\n")
						.map(
							line =>
								JSON.parse(line) as {
									method?: string;
									params?: { model?: unknown; input?: Array<{ text?: unknown }> };
								},
						);
					const thread = messages.find(message => message.method === "thread/start");
					const turn = messages.find(message => message.method === "turn/start");
					expect(thread?.params?.model).toBe("native/test-model");
					expect(thread?.params).toMatchObject({ approvalPolicy: "never" });
					expect(turn?.params?.input?.[0]?.text).toContain("Shared batch context");
				} else {
					expect(commands[0]).toContain("native/test-model");
					expect(commands[0]?.some(argument => argument.includes("Shared batch context"))).toBe(true);
				}
				expect(commands[0]).not.toContain("--dangerously-bypass-approvals-and-sandbox");
				expect(commands[0]).not.toContain("-y");
			} finally {
				fs.rmSync(capturePath, { force: true });
			}
		});
	}

	it("rejects a Claude-style native error result", async () => {
		const commands: string[][] = [];
		const external = createClaudeCodeExecutor(
			{ env: JSON.stringify({ FAKE_SCENARIO: "product-error" }) },
			fakeProcess("claude", commands),
		);
		const result = await runExternalSubagent(options(external));
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("denied");
	});

	it("reports malformed protocol output and nonzero process exits", async () => {
		for (const scenario of ["malformed", "nonzero"]) {
			const commands: string[][] = [];
			const external = createOpenCodeExecutor(
				{ env: JSON.stringify({ FAKE_SCENARIO: scenario }) },
				fakeProcess("opencode", commands),
			);
			const result = await runExternalSubagent(options(external));
			expect(result.exitCode).not.toBe(0);
			expect(result.error).toBeTruthy();
		}
	});

	it("waits for process exit when a running product is cancelled", async () => {
		const commands: string[][] = [];
		let child: ReturnType<typeof spawn> | undefined;
		const factory: ExternalProcessFactory = (command, processOptions) => {
			child = fakeProcess("opencode", commands)(command, processOptions) as ReturnType<typeof spawn>;
			return child;
		};
		const external = createOpenCodeExecutor({ env: JSON.stringify({ FAKE_SCENARIO: "hold" }) }, factory);
		const controller = new AbortController();
		const pending = runExternalSubagent(options(external, controller.signal));
		setTimeout(() => controller.abort("test cancellation"), 100);
		const result = await pending;
		expect(result).toMatchObject({ exitCode: 1, aborted: true });
		expect(child?.exitCode ?? child?.proc.signalCode).not.toBeNull();
	});

	it("answers Codex server approvals without waiting for a human", async () => {
		const commands: string[][] = [];
		const external = createCodexExecutor(
			{ env: JSON.stringify({ FAKE_SCENARIO: "approval" }) },
			fakeProcess("codex", commands),
		);
		const result = await runExternalSubagent(options(external));
		expect(result).toMatchObject({ exitCode: 0, output: "codex answer" });
	});
});
