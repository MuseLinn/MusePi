import type { ExtensionAPI, ExtensionContext } from "../../extensions/types";
import type { HookPointResult } from "./engine";
import { runHookPoint } from "./engine";
import type { CommandHookConfig, CommandHookEvent, HookDialect, HookRunRecord } from "./types";

/**
 * Map the shared command-hook engine onto MusePi's extension events.
 *
 * Event mapping (the reference bridges use the same points):
 *   SessionStart     → session_start      context injected as a hidden message
 *   UserPromptSubmit → before_agent_start deny → cancel the prompt
 *   PreToolUse       → tool_call          deny → block the call
 *   PostToolUse      → tool_result        deny → error result with the reason
 *   Stop             → session_stop       stop → continue the settle once
 *
 * Faithful-but-degraded where the host has no matching seam: `ask` has no
 * prompt-approval integration yet, so it is reported and treated as allow (the
 * same subset the Codex bridge supports). Claude's SubagentStart/SubagentStop
 * are parsed as skipped by the config loader because this host has no
 * per-subagent hook point.
 */

export interface CommandHookBridgeOptions {
	dialect: HookDialect;
	config: CommandHookConfig;
	/** Shell executable used to interpret hook command lines. */
	shell: string;
	/** `${CLAUDE_PROJECT_DIR}` and the process env value; defaults to the session cwd. */
	projectDir?: string;
	defaultTimeoutMs: number;
}

const CONTEXT_CUSTOM_TYPE = "hook-context";

function sessionIdOf(session: ExtensionContext): string {
	try {
		return session.sessionManager.getSessionId();
	} catch {
		return "";
	}
}

function payloadBase(session: ExtensionContext, point: CommandHookEvent, cwd: string): Record<string, unknown> {
	return {
		session_id: sessionIdOf(session),
		// The durable transcript path is deliberately empty: the log is not a
		// plain file a hook script can read (same reason as the reference bridge).
		transcript_path: "",
		cwd,
		hook_event_name: point,
	};
}

function run(
	point: CommandHookEvent,
	query: string,
	payload: unknown,
	options: CommandHookBridgeOptions,
	cwd: string,
	session: ExtensionContext,
	signal?: AbortSignal,
): Promise<HookPointResult> {
	return runHookPoint(options.config, options.dialect, point, query, payload, {
		cwd,
		shell: options.shell,
		env: { CLAUDE_PROJECT_DIR: options.projectDir ?? cwd },
		defaultTimeoutMs: options.defaultTimeoutMs,
		...(signal ? { signal } : {}),
	});
}

function notify(session: ExtensionContext, message: string | undefined): void {
	if (!message) return;
	session.ui?.notify(message, "warning");
}

/** Context a hook point contributes, in hook order; plain stdout counts for the two context points. */
function contextsOf(point: CommandHookEvent, result: HookPointResult): string[] {
	const out = [...result.merged.additionalContext];
	if (point === "SessionStart" || point === "UserPromptSubmit") {
		for (const record of result.records) {
			const stdout = record.output.stdout;
			if (record.output.exitCode === 0 && stdout.length > 0 && !stdout.startsWith("{")) {
				out.push(stdout);
			}
		}
	}
	return out;
}

/** Keep a compact, hidden audit trail for outcomes that mattered (block/failure). */
function audit(pi: ExtensionAPI, point: CommandHookEvent, dialect: HookDialect, result: HookPointResult): void {
	for (const record of result.records) {
		const blocking = record.output.decision === "deny" || record.output.decision === "block";
		const failed = record.output.exitCode !== undefined && record.output.exitCode !== 0;
		if (!blocking && !failed) continue;
		try {
			pi.appendEntry?.("hook-result", {
				point,
				dialect,
				decision: blocking ? "block" : "allow",
				exitCode: record.output.exitCode,
				stderr: record.output.stderr.slice(0, 500),
				durationMs: record.durationMs,
			});
		} catch {
			// Audit is best-effort: a host without a live session runtime must not
			// lose the hook's actual decision because the log entry could not land.
		}
	}
}

function warningsOf(result: HookPointResult, records: readonly HookRunRecord[]): string[] {
	const out = [...result.merged.systemMessages];
	for (const record of records) {
		if (record.output.exitCode !== undefined && record.output.exitCode !== 0 && record.output.stderr) {
			out.push(record.output.stderr);
		}
	}
	return out;
}

export function installCommandHookBridge(pi: ExtensionAPI, options: CommandHookBridgeOptions): void {
	pi.on("session_start", async (_event, session) => {
		const cwd = session.cwd;
		const result = await run(
			"SessionStart",
			"startup",
			{ ...payloadBase(session, "SessionStart", cwd), source: "startup" },
			options,
			cwd,
			session,
		);
		audit(pi, "SessionStart", options.dialect, result);
		for (const warning of warningsOf(result, result.records)) notify(session, warning);
		const contexts = contextsOf("SessionStart", result);
		if (contexts.length > 0) {
			try {
				pi.sendMessage(
					{ customType: CONTEXT_CUSTOM_TYPE, content: contexts.join("\n\n"), display: false, attribution: "user" },
					{ deliverAs: "nextTurn" },
				);
			} catch (error) {
				// Context is an enhancement; a host that cannot queue it yet must
				// still finish session startup.
				pi.logger.warn(
					`hook SessionStart context was not queued: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	});

	pi.on("before_agent_start", async (event, session) => {
		const cwd = session.cwd;
		const result = await run(
			"UserPromptSubmit",
			"",
			{ ...payloadBase(session, "UserPromptSubmit", cwd), prompt: event.prompt },
			options,
			cwd,
			session,
		);
		audit(pi, "UserPromptSubmit", options.dialect, result);
		for (const warning of warningsOf(result, result.records)) notify(session, warning);
		if (result.merged.decision === "deny") {
			const reason = result.merged.reason ?? "The prompt was rejected by a UserPromptSubmit hook.";
			notify(session, reason);
			return { cancel: true, reason };
		}
		if (result.merged.decision === "ask") {
			notify(
				session,
				"A UserPromptSubmit hook asked for confirmation; this host cannot prompt for prompt submission and allows it.",
			);
		}
		const contexts = contextsOf("UserPromptSubmit", result);
		if (contexts.length > 0) {
			return {
				message: {
					customType: CONTEXT_CUSTOM_TYPE,
					content: contexts.join("\n\n"),
					display: false,
					attribution: "user",
				},
			};
		}
		return undefined;
	});

	pi.on("tool_call", async (event, session) => {
		const cwd = session.cwd;
		const result = await run(
			"PreToolUse",
			event.toolName,
			{ ...payloadBase(session, "PreToolUse", cwd), tool_name: event.toolName, tool_input: event.input },
			options,
			cwd,
			session,
		);
		audit(pi, "PreToolUse", options.dialect, result);
		for (const warning of warningsOf(result, result.records)) notify(session, warning);
		if (result.merged.decision === "deny") {
			return {
				block: true,
				reason: result.merged.reason ?? `The ${event.toolName} call was blocked by a PreToolUse hook.`,
			};
		}
		if (result.merged.decision === "ask") {
			notify(
				session,
				`A PreToolUse hook asked for confirmation on ${event.toolName}; this host allows it (no hook-level approval prompt yet).`,
			);
		}
		return undefined;
	});

	pi.on("tool_result", async (event, session) => {
		const cwd = session.cwd;
		const result = await run(
			"PostToolUse",
			event.toolName,
			{
				...payloadBase(session, "PostToolUse", cwd),
				tool_name: event.toolName,
				tool_input: event.input,
				tool_response: { content: event.content, isError: event.isError },
			},
			options,
			cwd,
			session,
		);
		audit(pi, "PostToolUse", options.dialect, result);
		for (const warning of warningsOf(result, result.records)) notify(session, warning);
		if (result.merged.decision === "deny") {
			return {
				block: true,
				reason: result.merged.reason ?? `The ${event.toolName} result was rejected by a PostToolUse hook.`,
			};
		}
		if (result.merged.decision === "ask") {
			notify(session, `A PostToolUse hook asked for confirmation on ${event.toolName}; this host allows it.`);
		}
		const contexts = contextsOf("PostToolUse", result);
		if (contexts.length > 0) {
			return {
				content: [...event.content, { type: "text" as const, text: contexts.join("\n\n") }],
			};
		}
		return undefined;
	});

	pi.on("session_stop", async (_event, session) => {
		const cwd = session.cwd;
		const result = await run(
			"Stop",
			"",
			{ ...payloadBase(session, "Stop", cwd), stop_hook_active: false },
			options,
			cwd,
			session,
			_event.signal,
		);
		audit(pi, "Stop", options.dialect, result);
		for (const warning of warningsOf(result, result.records)) notify(session, warning);
		if (result.merged.stop) {
			const reason = result.merged.stopReason ?? result.merged.reason ?? "A Stop hook requested another step.";
			return { decision: "block" as const, reason };
		}
		return undefined;
	});
}
