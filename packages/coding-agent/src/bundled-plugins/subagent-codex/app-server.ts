/** Minimal one-turn Codex app-server JSON-RPC adapter. */
import { AbortError, type ChildProcess } from "@musepi/pi-utils/ptree";
import { type ExternalProcessFactory, externalDisposeGrace, spawnExternalProcess } from "../../task/external-cli";
import type { ExternalSubagentContext, ExternalSubagentResult } from "../../task/types";

export interface CodexAppServerSpec {
	command: string[];
	cwd: string;
	task: string;
	env: Record<string, string>;
	model?: string;
	permissionMode: string;
	disposeGraceMs?: number;
}

type JsonObject = Record<string, unknown>;
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function object(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Codex returned invalid ${label}`);
	return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Codex returned invalid ${label}`);
	return value;
}

function abortMessage(signal: AbortSignal): string {
	return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "Cancelled");
}

function permissionParams(mode: string): JsonObject {
	if (mode === "approve-for-me") {
		return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
	}
	if (mode === "dangerously-bypass-approvals-and-sandbox") {
		return { approvalPolicy: "never", sandbox: "danger-full-access" };
	}
	return { approvalPolicy: "never" };
}

/** Run one ephemeral thread and turn over the official stdio protocol. */
export async function runCodexAppServer(
	context: ExternalSubagentContext,
	spec: CodexAppServerSpec,
	factory: ExternalProcessFactory = spawnExternalProcess,
): Promise<ExternalSubagentResult> {
	const child = factory(spec.command, {
		cwd: spec.cwd,
		env: { ...Bun.env, ...spec.env },
		signal: context.signal,
		stdin: "pipe",
	}) as ChildProcess<"pipe">;
	const pending = new Map<number, PendingRequest>();
	let nextId = 1;
	let terminal = false;
	let failed: Error | undefined;
	let finalAnswer: string | undefined;
	let partialAnswer: string | undefined;
	let unphasedAnswer: string | undefined;
	let turnWait: PromiseWithResolvers<void> | undefined;
	const write = (value: JsonObject): void => {
		child.stdin.write(`${JSON.stringify(value)}\n`);
	};
	const request = async (method: string, params?: JsonObject): Promise<unknown> => {
		const id = nextId++;
		const waiter = Promise.withResolvers<unknown>();
		pending.set(id, waiter);
		write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
		return waiter.promise;
	};
	const respondToServerRequest = (id: string | number, method: string, params: JsonObject): void => {
		if (/requestApproval|requestUserInput|elicitation|permission/i.test(method)) {
			const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
			const decision = decisions.includes("cancel") ? "cancel" : "decline";
			write({ jsonrpc: "2.0", id, result: { decision } });
			return;
		}
		write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unattended MusePi cannot answer ${method}` } });
	};
	const recordAnswer = (text: string, phase: unknown): void => {
		if (phase === "final_answer") finalAnswer = text;
		else if (phase === "partial_answer") partialAnswer = text;
		else if (phase === undefined || phase === null) unphasedAnswer = text;
		context.report({ output: finalAnswer ?? partialAnswer ?? unphasedAnswer ?? "" });
	};
	const handleNotification = (method: string, params: JsonObject): void => {
		if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
			recordAnswer(params.delta, params.phase);
			return;
		}
		if (method === "item/completed") {
			const item = object(params.item ?? {}, "completed item");
			if (item.type === "agentMessage" && typeof item.text === "string") recordAnswer(item.text, item.phase);
			return;
		}
		if (method === "turn/completed") {
			const turn = object(params.turn, "completed turn");
			if (turn.status === "failed") {
				const error = object(turn.error ?? {}, "turn error");
				failed = new Error(typeof error.message === "string" ? error.message : "Codex turn failed");
			} else if (turn.status === "interrupted") {
				failed = new Error("Codex turn was interrupted");
			}
			terminal = true;
			turnWait?.resolve();
		}
	};
	const read = async (): Promise<void> => {
		const decoder = new TextDecoder();
		let buffer = "";
		const consume = (line: string): void => {
			if (!line.trim()) return;
			const message = object(JSON.parse(line), "JSON-RPC message");
			if (message.id !== undefined && message.method === undefined) {
				const waiter = pending.get(Number(message.id));
				if (!waiter) return;
				pending.delete(Number(message.id));
				if (message.error) {
					const error = object(message.error, "JSON-RPC error");
					waiter.reject(new Error(typeof error.message === "string" ? error.message : "Codex request failed"));
				} else waiter.resolve(message.result);
				return;
			}
			if (message.id !== undefined && typeof message.method === "string") {
				respondToServerRequest(
					message.id as string | number,
					message.method,
					object(message.params ?? {}, "request"),
				);
				return;
			}
			if (typeof message.method === "string")
				handleNotification(message.method, object(message.params ?? {}, "notification"));
		};
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) consume(line);
		}
		buffer += decoder.decode();
		consume(buffer);
		if (!terminal) throw new Error("Codex app-server ended before completing the turn");
	};
	const reading = read().catch(error => {
		failed ??= error instanceof Error ? error : new Error(String(error));
		for (const waiter of pending.values()) waiter.reject(failed);
		pending.clear();
		turnWait?.reject(failed);
	});
	try {
		object(
			await request("initialize", {
				clientInfo: { name: "musepi", title: "MusePi", version: "0.7.0" },
				capabilities: { experimentalApi: false, requestAttestation: false },
			}),
			"initialize response",
		);
		write({ jsonrpc: "2.0", method: "initialized" });
		const thread = object(
			await request("thread/start", {
				ephemeral: true,
				cwd: spec.cwd,
				...permissionParams(spec.permissionMode),
				...(spec.model ? { model: spec.model } : {}),
			}),
			"thread/start response",
		);
		const threadData = object(thread.thread, "thread");
		const threadId = requiredString(threadData.id, "thread id");
		const turn = object(
			await request("turn/start", {
				threadId,
				input: [{ type: "text", text: spec.task }],
			}),
			"turn/start response",
		);
		object(turn.turn, "turn");
		turnWait = Promise.withResolvers<void>();
		if (terminal) turnWait.resolve();
		await turnWait.promise;
		if (failed) throw failed;
		const output = finalAnswer ?? partialAnswer ?? unphasedAnswer ?? "";
		if (!output.trim()) throw new Error("Codex returned an empty response");
		return { output, stderr: child.peekStderr(), exitCode: 0 };
	} catch (error) {
		return {
			output: finalAnswer ?? partialAnswer ?? unphasedAnswer ?? "",
			stderr: child.peekStderr(),
			exitCode: 1,
			error: error instanceof Error ? error.message : String(error),
			aborted: context.signal.aborted,
			abortReason: context.signal.aborted ? abortMessage(context.signal) : undefined,
		};
	} finally {
		await child.terminate(
			new AbortError(
				context.signal.aborted ? abortMessage(context.signal) : "Codex turn settled",
				child.peekStderr(),
			),
			externalDisposeGrace(spec.disposeGraceMs),
		);
		await reading.catch(() => {});
	}
}
