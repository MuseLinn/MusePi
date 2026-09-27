/**
 * Contract: a session created with `projectMetadata.designSystemId` gets the
 * selected design system's prompt brief injected into the assembled system
 * prompt, positioned AFTER the mode preset sections (composer order 40; M3 §3).
 * Unknown/empty ids inject nothing and never fail session guidance.
 *
 * Why this exists: the injection is the whole value of the design-system
 * axis — a regression means the agent designs blind (no brief) or the brief
 * lands ahead of the mode's role block and dilutes it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
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

const MODE_MARKER = "MODE-SECTION-MARKER-7f3a9c";
const GLASS_BRIEF = BUILTIN_DESIGN_SYSTEMS.find(s => s.id === "glass")?.promptSection.text ?? "";
const GLASS_BRIEF_HEAD = GLASS_BRIEF.slice(0, 40);

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "design-system-model",
		name: "Design System Model",
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

async function createDesignSession(
	tempDir: TempDir,
	metadata: Record<string, unknown> | undefined,
): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	// A scratch mode carrying one preset section — the anchor the design brief
	// must land behind.
	const modesDir = tempDir.join("modes");
	await fs.mkdir(modesDir, { recursive: true });
	await fs.writeFile(
		path.join(modesDir, "designtest.json"),
		JSON.stringify({
			id: "designtest",
			label: "Design Test",
			prompt: [{ name: "mode:designtest:role", order: 25, text: MODE_MARKER }],
		}),
	);

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const session = (
		await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modeDir: modesDir,
			modeId: "designtest",
			...(metadata ? { projectMetadata: metadata } : {}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(`design-system-${Bun.nanoseconds().toString(36)}`),
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
	return { session, authStorage };
}

describe("design system prompt injection (projectMetadata.designSystemId)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("injects the glass brief after the mode preset section", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-");
		const { session, authStorage } = await createDesignSession(tempDir, {
			version: 1,
			designSystemId: "glass",
		});
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(GLASS_BRIEF_HEAD);
			expect(prompt.indexOf(GLASS_BRIEF_HEAD)).toBeGreaterThan(prompt.indexOf(MODE_MARKER));
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("injects nothing for an unknown designSystemId and does not fail guidance", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-");
		const { session, authStorage } = await createDesignSession(tempDir, {
			version: 1,
			designSystemId: "no-such-system",
		});
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(MODE_MARKER);
			expect(prompt).not.toContain(GLASS_BRIEF_HEAD);
			expect(prompt).not.toContain("设计体系「");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("injects nothing when projectMetadata is absent", async () => {
		using tempDir = TempDir.createSync("@pi-design-system-");
		const { session, authStorage } = await createDesignSession(tempDir, undefined);
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(MODE_MARKER);
			expect(prompt).not.toContain("设计体系「");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
