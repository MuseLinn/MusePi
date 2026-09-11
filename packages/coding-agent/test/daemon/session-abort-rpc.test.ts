import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { isUserInterruptAbort, USER_INTERRUPT_LABEL } from "../../src/session/messages";

/**
 * `session.abort` interrupt label. Regression: the daemon threaded the literal
 * "user interrupt" while AgentSession.abort() matches USER_INTERRUPT_LABEL
 * ("Interrupted by user") by strict equality — so a GUI stop never set the
 * UserInterrupt flag and the turn ended as a generic abort. Observable
 * consequences: the transcript showed the raw reason instead of the interrupt
 * card, and advisor auto-resume was NOT suppressed, so the advisor could
 * restart a turn the user had deliberately stopped.
 */
describe("session.abort RPC", () => {
	/** Run the RPC against a stub session and report the reason it aborted with. */
	async function abortReason(): Promise<string | undefined> {
		let seen: string | undefined;
		const host = {
			cwd: () => "/tmp",
			get: () => ({
				sessionId: "s1",
				agentSession: {
					abort: async (options?: { reason?: string }) => {
						seen = options?.reason;
					},
				},
			}),
			setCollabToolProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const conn = { id: "test" } as unknown as DaemonConnection;
		await server.handle("session.abort", { sessionId: "s1" }, conn);
		return seen;
	}

	test("aborts with a reason the transcript recognises as a user interrupt", async () => {
		const reason = await abortReason();
		// The label is what the abort surfaces on the assistant message, and
		// isUserInterruptAbort is what the transcript renders the interrupt card
		// from — the daemon's reason must satisfy it, not merely resemble it.
		expect(isUserInterruptAbort({ errorMessage: reason })).toBe(true);
		expect(reason).toBe(USER_INTERRUPT_LABEL);
	});
});
