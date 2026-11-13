import { describe, expect, it } from "bun:test";
import { DaemonHostContext } from "../host-context";
import type { DaemonSessionHost } from "../session-host";
import { SessionPresenceService } from "./session-presence-service";

describe("SessionPresenceService", () => {
	it("mounts as ctx.sessionPresence and serves the persisted row", async () => {
		const service = new SessionPresenceService({
			get: () => undefined,
			knownSessions: (async () => [
				{ sessionId: "s1", createdAt: 1, updatedAt: 2, messageCount: 0, cwd: "" },
			]) as unknown as DaemonSessionHost["knownSessions"],
		});
		const host = new DaemonHostContext();
		await host.mount(service);

		expect(host.get("sessionPresence")).toBe(service);
		await expect(service.presence({ sessionId: "s1" })).resolves.toMatchObject({
			sessionId: "s1",
			phase: "idle",
			live: false,
		});
		await expect(service.presence({})).resolves.toEqual({ error: "sessionId required" });
		await host.dispose();
	});
});
