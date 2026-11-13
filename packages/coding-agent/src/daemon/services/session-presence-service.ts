/**
 * SessionPresenceService — the public per-session presence contract as an L2
 * daemon service.
 *
 * Seam:
 * - Input: the daemon session host (`get` + `knownSessions`) and a session id.
 * - Output: `SessionPresence` for one session; `session.list` also embeds it
 *   per row. The pure derivation stays in `../session-presence.ts`.
 * - Lifecycle: stateless; mounting it on the cordis host exposes
 *   `ctx.sessionPresence` and makes `session.presence` a claimed route.
 */

import type { SessionPresence } from "@musepi/pi-wire";
import type { DaemonSessionHost } from "../session-host";
import { deriveSessionPresence, type SessionPresenceRow } from "../session-presence";
import type { DaemonService } from "./types";

export class SessionPresenceService implements DaemonService {
	readonly key = "sessionPresence";
	readonly routes = { "session.presence": "presence" } as const;

	constructor(private readonly host: Pick<DaemonSessionHost, "get" | "knownSessions">) {}

	derive(live: Parameters<typeof deriveSessionPresence>[0], row: SessionPresenceRow): SessionPresence {
		return deriveSessionPresence(live, row);
	}

	async presence(params: { sessionId?: unknown } = {}): Promise<SessionPresence | { error: string }> {
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		if (!sessionId) return { error: "sessionId required" };
		const live = this.host.get(sessionId);
		const row = (await this.host.knownSessions()).find(candidate => candidate.sessionId === sessionId);
		if (!live && !row) return { error: "session not found" };
		return this.derive(live, {
			sessionId,
			updatedAt: new Date(row?.updatedAt ?? Date.now()).toISOString(),
			status: row?.status,
		});
	}
}
