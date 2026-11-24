/**
 * The GUI's stable client identity, and the send identity built from it.
 *
 * A send is identified by `msg:<clientId>:<clientRequestId>`: the daemon
 * stamps that exact string on the user message it persists (idempotency), and
 * the transcript keys the row by it (`entryViewKey`). The optimistic row, the
 * RPC and the row that replaces the echo therefore name ONE row, so the ack
 * never remounts the bubble. The sending composer mints it before the send
 * path touches the DOM, so the echo and the wire call share it.
 */
export interface SendCorrelation {
	clientId: string;
	clientRequestId: string;
}

const CLIENT_ID_KEY = "musepi-gui-client-id";

/** The id this window sends as. Persisted; minted on first use. */
export function guiClientId(): string {
	if (typeof localStorage === "undefined") return "client";
	const stored = localStorage.getItem(CLIENT_ID_KEY);
	if (stored) return stored;
	const created = crypto.randomUUID();
	localStorage.setItem(CLIENT_ID_KEY, created);
	return created;
}

/** A fresh send identity. */
export function createSendCorrelation(clientId: string = guiClientId()): SendCorrelation {
	return { clientId, clientRequestId: crypto.randomUUID() };
}

/** The identity the daemon will stamp on the message for this send. */
export function sendRequestIdentity(correlation: SendCorrelation): string {
	return `msg:${correlation.clientId}:${correlation.clientRequestId}`;
}
