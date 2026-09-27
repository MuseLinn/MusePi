/**
 * Contract: `session.setDesignSystem` — the GUI design-system picker's write
 * channel (M3 §3).
 *
 * Observable contracts defended here:
 *  1. Live session: setting an id puts that system's prompt brief into the
 *     assembled system prompt immediately (next model call designs with it);
 *     clearing removes the brief. A regression means the picker lies — the
 *     GUI shows a selection the agent never sees (or keeps designing with a
 *     cleared system).
 *  2. Unknown ids are rejected with a semantic error before any state is
 *     touched — a regression means dangling selections get persisted and
 *     silently inject nothing on rebuild.
 *  3. History (non-live) sessions: the daemon merges the `designSystemId`
 *     key into the persisted project metadata — a regression means the other
 *     creation-metadata keys (kind/intent/…) are wiped the first time the
 *     user picks a style on a closed session.
 *  4. Both paths mirror the merged metadata to `<cwd>/.musepi/project.json`
 *     (best-effort) — a regression means the creation surface and the daemon
 *     header disagree about the selected system.
 *  5. Reactivation: a design-system choice made before a session was closed
 *     is re-injected into the resumed session's system prompt — a regression
 *     means the user re-opens a session and the agent silently designs
 *     without the selected brief until the style is re-picked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@musepi/pi-ai";
import { buildModel } from "@musepi/pi-catalog/build";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { BUILTIN_DESIGN_SYSTEMS } from "@musepi/pi-coding-agent/presets/design-systems";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { DaemonServer, DaemonSessionHost, JOURNAL_DIR } from "../src/daemon/server";
import { ViewStore, viewStorePath } from "../src/daemon/view-store";
import { computeDefaultSessionDir } from "../src/session/session-paths";
import { FileSessionStorage } from "../src/session/session-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const GLASS_BRIEF = BUILTIN_DESIGN_SYSTEMS.find(s => s.id === "glass")?.promptSection.text ?? "";
const GLASS_BRIEF_HEAD = GLASS_BRIEF.slice(0, 40);
const MINIMAL_BRIEF_HEAD = (BUILTIN_DESIGN_SYSTEMS.find(s => s.id === "minimal")?.promptSection.text ?? "").slice(
	0,
	40,
);

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "design-system-set-model",
		name: "Design System Set Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

async function createSessionWithoutMetadata(tempDir: TempDir): Promise<{ session: AgentSession; auth: AuthStorage }> {
	const auth = await AuthStorage.create(tempDir.join("auth.db"));
	auth.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(auth, tempDir.join("models.yml"));
	const session = (
		await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage: auth,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(`design-system-set-${Bun.nanoseconds().toString(36)}`),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		})
	).session;
	await session.refreshBaseSystemPrompt();
	return { session, auth };
}

/** Poll until the fire-and-forget mirror write lands (best-effort contract). */
async function readMirrorEventually(cwd: string): Promise<Record<string, unknown> | null> {
	const mirrorPath = path.join(cwd, ".musepi", "project.json");
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const parsed = JSON.parse(await fs.readFile(mirrorPath, "utf8")) as unknown;
			if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
		} catch {
			// not written yet
		}
		await Bun.sleep(20);
	}
	return null;
}

describe("session.setDesignSystem — live AgentSession", () => {
	test("set injects the brief immediately; clear removes it", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-set-");
		const { session, auth } = await createSessionWithoutMetadata(tempDir);
		try {
			expect(session.systemPrompt.join("\n")).not.toContain(GLASS_BRIEF_HEAD);

			await session.setDesignSystemId("glass");
			expect(session.systemPrompt.join("\n")).toContain(GLASS_BRIEF_HEAD);

			await session.setDesignSystemId(null);
			expect(session.systemPrompt.join("\n")).not.toContain(GLASS_BRIEF_HEAD);
			expect(session.getProjectMetadata()).toBeNull();
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	test("re-selecting replaces the previous system's brief (never two sections)", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-set-");
		const { session, auth } = await createSessionWithoutMetadata(tempDir);
		try {
			await session.setDesignSystemId("minimal");
			expect(session.systemPrompt.join("\n")).toContain(MINIMAL_BRIEF_HEAD);

			await session.setDesignSystemId("glass");
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(GLASS_BRIEF_HEAD);
			expect(prompt).not.toContain(MINIMAL_BRIEF_HEAD);
			// Exactly one design-system section survives the switch.
			expect(prompt.split("设计体系「").length - 1).toBe(1);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	test("set preserves the other creation-metadata keys on the shared holder", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-set-");
		const auth = await AuthStorage.create(tempDir.join("auth.db"));
		auth.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(auth, tempDir.join("models.yml"));
		const session = (
			await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage: auth,
				modelRegistry,
				projectMetadata: { version: 1, kind: "prototype", designSystemId: "minimal" },
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: buildLocalModel(`design-system-set-${Bun.nanoseconds().toString(36)}`),
				disableExtensionDiscovery: true,
				skills: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			})
		).session;
		try {
			await session.setDesignSystemId("glass");
			expect(session.getProjectMetadata()).toEqual({ version: 1, kind: "prototype", designSystemId: "glass" });

			await session.setDesignSystemId(null);
			expect(session.getProjectMetadata()).toEqual({ version: 1, kind: "prototype" });
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});

describe("session.setDesignSystem — RPC route", () => {
	function connOf(): Parameters<DaemonServer["handle"]>[2] {
		return { id: "test" } as never;
	}

	test("rejects an unknown designSystemId before touching session or store state", async () => {
		let liveTouched = false;
		let storeTouched = false;
		const host = {
			cwd: () => "/tmp",
			get: () => ({
				sessionId: "s1",
				cwd: "/tmp",
				agentSession: {
					setDesignSystemId: async () => {
						liveTouched = true;
					},
				},
			}),
			persistHeaderPatch: () => {
				storeTouched = true;
				return true;
			},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		await expect(
			server.handle("session.setDesignSystem", { sessionId: "s1", designSystemId: "no-such-system" }, connOf()),
		).rejects.toThrow("Unknown design system: no-such-system");
		expect(liveTouched).toBe(false);
		expect(storeTouched).toBe(false);
	});

	test("live session: routes to AgentSession and persists the merged metadata + mirror", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-rpc-");
		const calls: Array<string | null> = [];
		let persistedPatch: { projectMetadata?: Record<string, unknown> | null } | undefined;
		const host = {
			cwd: () => tempDir.path(),
			get: () => ({
				sessionId: "s1",
				cwd: tempDir.path(),
				agentSession: {
					setDesignSystemId: async (id: string | null) => {
						calls.push(id);
					},
					getProjectMetadata: () => ({ version: 1, kind: "prototype" }),
				},
			}),
			persistHeaderPatch: (_sessionId: string, patch: { projectMetadata?: Record<string, unknown> | null }) => {
				persistedPatch = patch;
				return true;
			},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const result = (await server.handle(
			"session.setDesignSystem",
			{ sessionId: "s1", designSystemId: "glass" },
			connOf(),
		)) as { ok: boolean };
		expect(result.ok).toBe(true);
		expect(calls).toEqual(["glass"]);
		expect(persistedPatch?.projectMetadata).toEqual({ version: 1, kind: "prototype", designSystemId: "glass" });
		expect(await readMirrorEventually(tempDir.path())).toEqual({
			version: 1,
			kind: "prototype",
			designSystemId: "glass",
		});
	});

	test("live session: clearing persists an explicit null when no other metadata keys remain", async () => {
		let persistedPatch: { projectMetadata?: Record<string, unknown> | null } | undefined;
		const host = {
			cwd: () => "/tmp",
			get: () => ({
				sessionId: "s1",
				cwd: "/tmp",
				agentSession: {
					setDesignSystemId: async () => {},
					getProjectMetadata: () => ({ designSystemId: "glass" }),
				},
			}),
			persistHeaderPatch: (_sessionId: string, patch: { projectMetadata?: Record<string, unknown> | null }) => {
				persistedPatch = patch;
				return true;
			},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		// designSystemId omitted entirely = clear, same as explicit null.
		const result = (await server.handle("session.setDesignSystem", { sessionId: "s1" }, connOf())) as { ok: boolean };
		expect(result.ok).toBe(true);
		expect(persistedPatch?.projectMetadata).toBeNull();
	});

	test("history session: merges designSystemId into the persisted header, keeping the other creation keys", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-rpc-");
		const persisted: Array<{ projectMetadata?: Record<string, unknown> | null }> = [];
		const host = {
			cwd: () => "/tmp",
			get: () => undefined,
			readProjectMetadata: () => ({
				metadata: { version: 1, kind: "prototype", designSystemId: "minimal" },
				cwd: tempDir.path(),
			}),
			persistHeaderPatch: (_sessionId: string, patch: { projectMetadata?: Record<string, unknown> | null }) => {
				persisted.push(patch);
				return true;
			},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);

		const setResult = (await server.handle(
			"session.setDesignSystem",
			{ sessionId: "hist", designSystemId: "glass" },
			connOf(),
		)) as { ok: boolean; persisted: boolean };
		expect(setResult).toEqual({ ok: true, persisted: true });
		expect(persisted[0]?.projectMetadata).toEqual({
			version: 1,
			kind: "prototype",
			designSystemId: "glass",
		});
		expect(await readMirrorEventually(tempDir.path())).toEqual({
			version: 1,
			kind: "prototype",
			designSystemId: "glass",
		});

		const clearResult = (await server.handle(
			"session.setDesignSystem",
			{ sessionId: "hist", designSystemId: null },
			connOf(),
		)) as { ok: boolean };
		expect(clearResult.ok).toBe(true);
		expect(persisted[1]?.projectMetadata).toEqual({ version: 1, kind: "prototype" });
	});

	test("history session: unknown session id surfaces `Unknown session`", async () => {
		const host = {
			cwd: () => "/tmp",
			get: () => undefined,
			readProjectMetadata: () => null,
			persistHeaderPatch: () => true,
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		await expect(
			server.handle("session.setDesignSystem", { sessionId: "ghost", designSystemId: "glass" }, connOf()),
		).rejects.toThrow("Unknown session: ghost");
	});
});

describe("session.setDesignSystem — reactivate rehydration (M3 §3)", () => {
	let isolatedAgentDir = "";

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("design-system-activate-");
	});

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	test("a design-system choice stored on a history session header is re-injected when the session is reactivated", async () => {
		// Seeded-history harness (branch-at.test.ts pattern): a real SDK
		// transcript on disk + a view-store row whose snapshot header
		// carries projectMetadata, then host.activate() → the resumed
		// AgentSession. Regression: #doActivate used to rebuild the
		// AgentSession without the persisted header's projectMetadata, so
		// a re-opened session designed without the selected brief until
		// the user re-picked the style.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "design-system-activate-ws-"));
		const sessionId = crypto.randomUUID();
		const host = new DaemonSessionHost({ cwd: workspace });
		try {
			const sessionDir = computeDefaultSessionDir(workspace, new FileSessionStorage());
			const transcript = path.join(
				sessionDir,
				`${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			);
			const header = {
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd: workspace,
			};
			const userLine = JSON.stringify({
				type: "message",
				id: crypto.randomBytes(4).toString("hex"),
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					timestamp: Date.now(),
					content: [{ type: "text", text: "seed" }],
				},
			});
			await fs.writeFile(transcript, `${JSON.stringify(header)}\n${userLine}\n`);

			// The daemon snapshot header is the authoritative carrier of
			// the creation metadata (persistHeaderPatch contract).
			new ViewStore(viewStorePath(JOURNAL_DIR)).upsert(sessionId, {
				cursor: 0,
				entries: [],
				agents: [],
				state: { isStreaming: false, queuedMessageCount: 0, cwd: workspace, participants: [] },
				header: {
					...header,
					projectMetadata: { version: 1, kind: "prototype", designSystemId: "glass" },
				},
			} as unknown as Parameters<ViewStore["upsert"]>[1]);

			const live = await host.activate(sessionId);
			expect(live.agentSession.systemPrompt.join("\n")).toContain(GLASS_BRIEF_HEAD);
			expect(live.agentSession.getProjectMetadata()).toEqual({
				version: 1,
				kind: "prototype",
				designSystemId: "glass",
			});
			host.close(sessionId);
			await Bun.sleep(500);
		} finally {
			host.dispose();
			// Shared default journal/view-store: remove only OUR rows/files
			// (daemon-suite cleanup contract).
			new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
			await fs.rm(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`), { force: true }).catch(() => {});
			const sessionDir = computeDefaultSessionDir(workspace, new FileSessionStorage());
			await fs.rm(sessionDir, { recursive: true, force: true });
			await fs.rm(workspace, { recursive: true, force: true });
		}
	}, 90000);
});
