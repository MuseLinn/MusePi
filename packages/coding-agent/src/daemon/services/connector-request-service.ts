import type { ConnectorRequestAnswerParams } from "@musepi/pi-wire";
import type { ApprovalBridge } from "../approval-bridge";
import type { DaemonService } from "./types";

/**
 * ConnectorRequestService — the GUI's answer to a `connector_catalog` request card.
 *
 * The card only decides whether to connect. Enabling happens inside the tool
 * call that asked (through the session's `connectorRequests` port, which runs
 * the same `connect` the settings page does), so this service never touches
 * connector state: it settles the parked wait and nothing else.
 */
export interface ConnectorRequestHostAccess {
	get(sessionId: string): { approvals: ApprovalBridge } | undefined;
	allSessions(): Iterable<{ approvals: ApprovalBridge }>;
}

export class ConnectorRequestService implements DaemonService {
	readonly key = "connectorRequests";
	readonly routes = {
		"connector.request.answer": "answer",
	} as const;

	readonly #deps: ConnectorRequestHostAccess;

	constructor(deps: ConnectorRequestHostAccess) {
		this.#deps = deps;
	}

	/** Settle one parked request. Returns false when it was already answered. */
	async answer(params: ConnectorRequestAnswerParams): Promise<{ ok: true }> {
		const p = (params ?? {}) as Partial<ConnectorRequestAnswerParams>;
		const requestId = typeof p.requestId === "string" ? p.requestId : "";
		if (!requestId) throw new Error("requestId required");
		if (p.decision !== "connect" && p.decision !== "decline") {
			throw new Error("decision must be connect or decline");
		}
		// A request lives in exactly one session; the id is the authority and a
		// supplied sessionId is only a shortcut. Searching every live session
		// keeps a client that reconnected from being unable to answer its card.
		const candidates = p.sessionId ? [this.#deps.get(p.sessionId)] : [...this.#deps.allSessions()];
		for (const live of candidates) {
			if (!live) continue;
			if (live.approvals.resolveConnector(requestId, p.decision)) return { ok: true };
		}
		throw new Error(`Unknown connector request: ${requestId}`);
	}
}
