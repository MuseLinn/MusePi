/**
 * The part of `connectors.connect` the agent-facing request path reads.
 *
 * Declared here rather than imported from the daemon service so the tool
 * contract stays type-only and does not depend on a daemon module. The service
 * returns a superset; this names only what a request has to decide from.
 */
export interface ConnectorConnectOutcome {
	ok: boolean;
	/** A browser grant is needed before the row becomes usable. */
	needsAuth?: boolean;
	/** The row signs in with a device code rather than a callback. */
	needsDeviceAuth?: boolean;
	/** A token connector still needs a value only the user can supply. */
	needsTokenConfig?: boolean;
	/** A local process waits for the user's explicit approval. */
	needsApproval?: boolean;
	/** A managed CLI package waits for its own authorization step. */
	needsCliAuth?: boolean;
	status?: "connected" | "connecting" | "disconnected";
}
