/**
 * Daemon MCP authorization bridge — the GUI's browser-grant gate.
 *
 * A tool call that hits an MCP server's `401` challenge parks inside
 * `MCPManager.reconnectServer` waiting for `MCPAuthHandler`. This module turns
 * that wait into one session event (`mcp-auth-request`) so the conversation
 * shows an authorization card, lets the grant settle on the flow's own OAuth
 * callback, and reports the terminal state (`mcp-auth-request-end`). The
 * caller decides whether the parked tool call may retry (success) or must fail.
 *
 * The authorization URL carries the CSRF `state` and the PKCE challenge, so it
 * rides only the requesting session's subscribers — never a broadcast, a log,
 * or the transcript.
 */

/** Wire payload of one parked authorization. */
export interface McpAuthRequest {
	requestId: string;
	serverName: string;
	flowId: string;
	authorizationUrl: string;
}

export type McpAuthOutcome = { status: "success" } | { status: "error" | "cancelled"; error?: string };

/** The OAuth flow owner, supplied by the daemon's `McpOAuthService`. */
export interface McpAuthFlowPort {
	start(serverName: string): Promise<{ flowId: string; authorizationUrl: string }>;
	settle(flowId: string): Promise<{ status: "success" | "error" | "cancelled"; error?: string }>;
	cancel(flowId: string): Promise<unknown> | void;
}

/** A parked tool call must not wait forever when the user walks away. */
export const DEFAULT_MCP_AUTH_TIMEOUT_MS = 10 * 60_000;

export interface RunMcpAuthorizationOptions {
	serverName: string;
	port: McpAuthFlowPort;
	/** Push the card to the requesting session's subscribers. */
	emitRequest(record: McpAuthRequest): void;
	/** Clear the card on every device, including ones that did not authorize. */
	emitEnd(requestId: string, outcome: McpAuthOutcome): void;
	/** 0 disables the deadline (tests and deliberate always-wait setups). */
	timeoutMs?: number;
	/** The parked tool call's abort signal: stopping the turn abandons the
	 *  grant and clears the card instead of leaving it on screen. */
	signal?: AbortSignal;
}

let counter = 0;

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split(/\r?\n/, 1)[0]?.trim() || "MCP authorization failed";
}

/**
 * Park on one browser grant. Resolves with the terminal outcome after the card
 * was announced and cleared; a start failure throws (nothing was announced).
 */
export async function runMcpAuthorization(options: RunMcpAuthorizationOptions): Promise<McpAuthOutcome> {
	const { serverName, port, emitRequest, emitEnd } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_AUTH_TIMEOUT_MS;
	if (options.signal?.aborted) return { status: "cancelled" };
	const started = await port.start(serverName);
	const requestId = `daemon-mcp-auth-${Date.now()}-${++counter}`;
	emitRequest({
		requestId,
		serverName,
		flowId: started.flowId,
		authorizationUrl: started.authorizationUrl,
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = Promise.withResolvers<McpAuthOutcome>();
	const abort = Promise.withResolvers<McpAuthOutcome>();
	const signal = options.signal;
	const onAbort = (): void => abort.resolve({ status: "cancelled" });
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	if (timeoutMs > 0) {
		timer = setTimeout(
			() =>
				deadline.resolve({
					status: "error",
					error: `Authorization was not completed within ${Math.round(timeoutMs / 60_000)} minutes`,
				}),
			timeoutMs,
		);
		timer.unref?.();
	}

	let outcome: McpAuthOutcome;
	let cancelFlow = false;
	try {
		const settled = await Promise.race([
			port.settle(started.flowId),
			deadline.promise,
			...(signal ? [abort.promise] : []),
		]);
		outcome =
			settled.status === "success"
				? { status: "success" }
				: { status: settled.status, ...(settled.error ? { error: settled.error } : {}) };
		cancelFlow = settled.status !== "success";
	} catch (error) {
		// A settle failure (daemon shutdown, flow aborted) leaves a listener
		// behind unless the flow is cancelled explicitly.
		outcome = { status: "error", error: describe(error) };
		cancelFlow = true;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}

	if (cancelFlow) {
		try {
			await port.cancel(started.flowId);
		} catch {
			// The flow is already gone; the outcome still tells the agent why.
		}
	}
	emitEnd(requestId, outcome);
	return outcome;
}
