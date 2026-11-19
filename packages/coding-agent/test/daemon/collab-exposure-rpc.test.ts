import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * The exposure listing and authoritative share status, as a client sees them.
 * Probing must never start a tunnel, and a status query without a share must
 * say so instead of returning stale links.
 */
describe("collab exposure RPC", () => {
	let isolatedAgentDir: string;
	let server: DaemonServer;
	const host = {
		cwd: () => process.cwd(),
		get: () => undefined,
		activate: async () => undefined,
		subscribe: async () => ({ seq: 0 }),
		touch: () => {},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const conn = { id: "c1" } as unknown as DaemonConnection;

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("collab-exposure-rpc-");
		server = new DaemonServer(host);
	}, 30_000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30_000);

	test("lists LAN plus every builtin exposure with capabilities", async () => {
		const result = (await server.handle("collab.exposures", {}, conn)) as {
			default: string;
			exposures: Array<{
				id: string;
				health: string;
				label: string;
				capabilities: { guestInstall: boolean; publicExposure: boolean; stableUrl: boolean; thirdParty: boolean };
			}>;
		};
		expect(typeof result.default).toBe("string");
		const ids = result.exposures.map(entry => entry.id);
		expect(ids).toContain("lan");
		expect(ids).toContain("cloudflared");
		expect(ids).toContain("ngrok");
		expect(ids).toContain("tailscale");
		for (const entry of result.exposures) {
			expect(typeof entry.label).toBe("string");
			expect(["ready", "unavailable", "degraded"]).toContain(entry.health);
			expect(entry.capabilities).toEqual({
				guestInstall: expect.any(Boolean),
				publicExposure: expect.any(Boolean),
				stableUrl: expect.any(Boolean),
				thirdParty: expect.any(Boolean),
			});
		}
		const tailscale = result.exposures.find(entry => entry.id === "tailscale");
		expect(tailscale?.capabilities.guestInstall).toBe(true);
		const lan = result.exposures.find(entry => entry.id === "lan");
		expect(lan?.capabilities.publicExposure).toBe(false);
	});

	test("status without a share reports hosting: false", async () => {
		await expect(server.handle("remote-access.status", {}, conn)).resolves.toEqual({ hosting: false });
	});

	test("a session share without a session is refused before any transport starts", async () => {
		await expect(server.handle("collab.start", { mode: "session" }, conn)).rejects.toThrow(
			/open or create a session first/,
		);
		await expect(server.handle("collab.status", {}, conn)).resolves.toEqual({ hosting: false });
	});
});
