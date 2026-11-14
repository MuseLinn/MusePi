/**
 * The desktop shell lives behind slots: `app.chat` (conversation page),
 * `app.capability` (capability center), `panel.shell` and the rail. A daemon
 * that does not discover the desktop plugin packages serves no slot component,
 * and every one of those surfaces renders blank — the failure is invisible in
 * the row list, so pin the compiled contribution here.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../src/daemon/server";

const modesDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-slots-"));
process.env.MUSEPI_MODES_DIR = modesDir;

function makeHarness() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-slots-cwd-"));
	const host = {
		cwd: () => cwd,
		get: () => undefined,
		ensureRegistry: async () => null,
		settings: () => ({ get: () => undefined, getRaw: () => undefined }),
		snapshot: async () => ({ entries: [], state: {} }),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "slots", send: () => {} } as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return { rpc };
}

describe("desktop slot registration", () => {
	it("serves the chat view and capability center as slot components", async () => {
		const { rpc } = makeHarness();
		const res = (await rpc("extensions.list")) as {
			extensions: Array<{ id: string; builtin?: boolean; kind?: string }>;
			components: Array<{ slot: string; code?: string; extensionId: string }>;
		};
		const byId = new Map(res.extensions.map(entry => [entry.id, entry]));
		for (const id of ["chat-view", "capability-center", "panel"]) {
			expect(byId.get(id)?.builtin).toBe(true);
			expect(byId.get(id)?.kind).toBe("plugin-module");
		}
		const slots = new Set(res.components.map(component => component.slot));
		for (const slot of ["app.chat", "app.capability"]) {
			expect(slots).toContain(slot);
		}
		const chat = res.components.find(component => component.slot === "app.chat");
		expect((chat?.code?.length ?? 0) > 0).toBe(true);
	}, 120_000);

	it("answers the light poll without the compiled payloads", async () => {
		const { rpc } = makeHarness();
		const light = (await rpc("extensions.list", { components: false })) as {
			components?: unknown[];
			version?: string;
			extensions: unknown[];
		};
		expect(light.components).toBeUndefined();
		expect(typeof light.version).toBe("string");
		expect(Array.isArray(light.extensions)).toBe(true);
	}, 120_000);
});
