import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";
import { resolvePath } from "../src/utils/paths.ts";

type RecordedSessionEvent = SessionBeforeSwitchEvent | SessionShutdownEvent | SessionStartEvent;

describe("AgentSessionRuntime.moveCwd", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let savedAgentDir: string | undefined;

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		if (savedAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = savedAgentDir;
		}
		savedAgentDir = undefined;
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-move-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });

		savedAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: join(tempDir, "agent"),
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: projectA,
			agentDir: join(tempDir, "agent"),
			sessionManager: SessionManager.create(projectA),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, projectA, projectB };
	}

	it("relocates the session, rebuilds cwd-bound services, and preserves history", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost, projectB } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const previousSessionFile = runtimeHost.session.sessionFile!;
		expect(existsSync(previousSessionFile)).toBe(true);
		const entryCount = runtimeHost.session.sessionManager.getEntries().length;
		expect(entryCount).toBeGreaterThan(0);

		const result = await runtimeHost.moveCwd(projectB);
		expect(result).toEqual({ cancelled: false, moved: true });
		await runtimeHost.session.bindExtensions({});

		// Session state moved.
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(resolvePath(projectB));
		expect(runtimeHost.cwd).toBe(resolvePath(projectB));
		expect(existsSync(previousSessionFile)).toBe(false);
		const newSessionFile = runtimeHost.session.sessionFile!;
		expect(existsSync(newSessionFile)).toBe(true);
		expect(runtimeHost.session.sessionManager.getEntries().length).toBe(entryCount);

		// cwd-bound services were rebuilt for the destination.
		expect(runtimeHost.services.cwd).toBe(resolvePath(projectB));
		expect(runtimeHost.session.extensionRunner.createContext().cwd).toBe(resolvePath(projectB));

		expect(events).toEqual([
			{ type: "session_before_switch", reason: "move", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "move", targetSessionFile: newSessionFile },
			{ type: "session_start", reason: "move", previousSessionFile },
		]);

		// The session keeps working in the new project.
		await runtimeHost.session.prompt("still there?");
		expect(runtimeHost.session.sessionManager.getEntries().length).toBeGreaterThan(entryCount);
	});

	it("is a no-op when the target equals the current cwd", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost, projectA } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
		});

		const result = await runtimeHost.moveCwd(projectA);
		expect(result).toEqual({ cancelled: false, moved: false });
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(resolvePath(projectA));
		expect(events).toEqual([]);
	});

	it("throws for a missing target directory without touching the session", async () => {
		const { runtimeHost, projectA, projectB } = await createRuntimeHost(() => {});
		rmSync(projectB, { recursive: true, force: true });

		await expect(runtimeHost.moveCwd(projectB)).rejects.toThrow(/does not exist/);
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(resolvePath(projectA));
	});

	it("honors session_before_switch cancellation", async () => {
		const { runtimeHost, projectA, projectB } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				if (event.reason === "move") {
					return { cancel: true };
				}
			});
		});

		const sessionFileBefore = runtimeHost.session.sessionFile;
		const result = await runtimeHost.moveCwd(projectB);
		expect(result).toEqual({ cancelled: true, moved: false });
		expect(runtimeHost.session.sessionManager.getCwd()).toBe(resolvePath(projectA));
		expect(runtimeHost.session.sessionFile).toBe(sessionFileBefore);
	});
});
