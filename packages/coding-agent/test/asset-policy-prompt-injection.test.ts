/**
 * Contract: a session created with `projectMetadata.assetPolicy` gets the
 * matching asset-policy instruction injected into the assembled system
 * prompt through the same composer channel as the design-system brief
 * (source="asset-policy", order 41 right behind design-system's 40; M3.7c §4).
 * `ai-image` demands the generate_image/agnes_video_gen toolchain at asset
 * references; `placeholder` demands color-block placeholders and forbids
 * media generation. Missing/unknown values inject nothing and never fail
 * session guidance.
 *
 * Why this exists: the injection is the whole value of the asset-policy
 * axis — a regression means the agent either generates media the user asked
 * to placeholder (wasted calls), or placeholders assets the user asked to
 * generate (broken deliverables).
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
const POLICY_MARKER = "素材策略（";
const TOOLCHAIN_MARKER = "generate_image";
const VIDEO_TOOL_MARKER = "agnes_video_gen";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "asset-policy-model",
		name: "Asset Policy Model",
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

async function createPolicySession(
	tempDir: TempDir,
	metadata: Record<string, unknown> | undefined,
): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	// A scratch mode carrying one preset section — the anchor both the design
	// brief and the asset-policy section must land behind.
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
			model: buildLocalModel(`asset-policy-${Bun.nanoseconds().toString(36)}`),
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

describe("asset policy prompt injection (projectMetadata.assetPolicy)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ai-image injects the media-generation toolchain instruction", async () => {
		using tempDir = TempDir.createSync("@pi-asset-policy-");
		const { session, authStorage } = await createPolicySession(tempDir, {
			version: 1,
			assetPolicy: "ai-image",
		});
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(POLICY_MARKER);
			expect(prompt).toContain(TOOLCHAIN_MARKER);
			expect(prompt).toContain(VIDEO_TOOL_MARKER);
			expect(prompt).not.toContain("禁止调用 generate_image");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("placeholder injects the color-block placeholder instruction and forbids generation", async () => {
		using tempDir = TempDir.createSync("@pi-asset-policy-");
		const { session, authStorage } = await createPolicySession(tempDir, {
			version: 1,
			assetPolicy: "placeholder",
		});
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(POLICY_MARKER);
			expect(prompt).toContain("色块");
			expect(prompt).toContain(TOOLCHAIN_MARKER); // 禁令里点名该工具
			expect(prompt).toContain("禁止调用 generate_image");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("lands right behind the design-system brief (order 41 after 40)", async () => {
		using tempDir = TempDir.createSync("@pi-asset-policy-");
		const { session, authStorage } = await createPolicySession(tempDir, {
			version: 1,
			designSystemId: "glass",
			assetPolicy: "placeholder",
		});
		try {
			const prompt = session.systemPrompt.join("\n");
			const briefAt = prompt.indexOf(GLASS_BRIEF_HEAD);
			const policyAt = prompt.indexOf(POLICY_MARKER);
			expect(briefAt).toBeGreaterThan(-1);
			expect(policyAt).toBeGreaterThan(briefAt);
			expect(prompt.indexOf(MODE_MARKER)).toBeLessThan(briefAt);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("injects nothing for an unknown assetPolicy and does not fail guidance", async () => {
		using tempDir = TempDir.createSync("@pi-asset-policy-");
		const { session, authStorage } = await createPolicySession(tempDir, {
			version: 1,
			assetPolicy: "stock",
		});
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(MODE_MARKER);
			expect(prompt).not.toContain(POLICY_MARKER);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("injects nothing when projectMetadata is absent", async () => {
		using tempDir = TempDir.createSync("@pi-asset-policy-");
		const { session, authStorage } = await createPolicySession(tempDir, undefined);
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(MODE_MARKER);
			expect(prompt).not.toContain(POLICY_MARKER);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
