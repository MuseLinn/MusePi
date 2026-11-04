/**
 * Project context (AGENTS.md / workspace tree / active repo) host-section
 * contract (prompt pluginization — project & volatile context phase).
 *
 * The session used to render these three pieces inline inside the base
 * `buildSystemPrompt` project block. They now live on the session PromptHost as
 * cacheable sections (`cacheScope: "snapshot"`) under ONE owner, so the base
 * template must not render them a second time (double owner).
 *
 * Contract under test:
 * 1. 对照 (parity): the host-rendered sections are byte-identical to what the
 *    legacy `buildSystemPrompt` path renders for the same discovered input —
 *    discovery, rendering and dedup are reused, not reimplemented.
 * 2. Single owner: registering the sections repeatedly replaces them (one
 *    section per name, no accumulation), and `removeByOwner` releases all.
 * 3. Session level: a real session carries each piece exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import type { ContextFile } from "@musepi/pi-coding-agent/capability/context-file";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import {
	PROJECT_CONTEXT_OWNER,
	PROJECT_CONTEXT_SECTIONS,
	type ProjectContextState,
	registerProjectContextSections,
	renderProjectContextSections,
} from "@musepi/pi-coding-agent/prompts/project-context";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@musepi/pi-coding-agent/system-prompt";
import type { ActiveRepoContext } from "@musepi/pi-coding-agent/utils/active-repo-context";
import type { WorkspaceTree } from "@musepi/pi-coding-agent/workspace-tree";

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	[
		"glob",
		{
			label: "Glob",
			description: "Finds files by pattern.",
			parameters: { type: "object", properties: { pattern: { type: "string" } } },
		},
	],
]);

function contextFile(filePath: string, content: string, depth = 0): ContextFile {
	return {
		path: filePath,
		content,
		level: "project",
		depth,
		_source: { provider: "agents", providerName: "AGENTS.md", path: filePath, level: "project" },
	};
}

function workspaceTree(overrides: Partial<WorkspaceTree> = {}): WorkspaceTree {
	return {
		rootPath: "/project",
		rendered: ".\n  - src/\n  - package.json",
		truncated: false,
		totalLines: 3,
		agentsMdFiles: [],
		...overrides,
	};
}

function activeRepoContext(): ActiveRepoContext {
	return {
		cwd: "/project",
		repoRoot: "/project/active-project",
		relativeRepoRoot: "active-project",
		source: "single-direct-child-repo",
	};
}

function fullState(overrides: Partial<ProjectContextState> = {}): ProjectContextState {
	return {
		contextFiles: [contextFile("/project/AGENTS.md", "PROJECT RULES\n\nSecond paragraph.")],
		workspaceTree: workspaceTree(),
		includeWorkspaceTree: true,
		activeRepoContext: activeRepoContext(),
		baseOwnsContextFiles: false,
		...overrides,
	};
}

describe("project context host sections — legacy render parity", () => {
	it("renders the AGENTS/workspace-tree section byte-identical to the legacy base path", async () => {
		const state = fullState();
		const legacy = await buildSystemPrompt({
			cwd: "/project",
			contextFiles: [...state.contextFiles],
			workspaceTree: state.workspaceTree,
			includeWorkspaceTree: true,
			activeRepoContext: state.activeRepoContext,
			skills: [],
			rules: [],
			toolNames: ["read", "glob"],
			tools: TOOLS,
		});
		const legacyText = legacy.systemPrompt.join("\n\n");

		const sections = renderProjectContextSections(state);
		const agents = sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(agents).toBeDefined();
		expect(agents?.text).toBeDefined();
		// The legacy base renders the same blocks inside the project block; the
		// host section must reproduce them verbatim (same discovery + templates).
		expect(legacyText).toContain(agents!.text!.trim());
		expect(agents!.text).toContain("<repo-rules>");
		expect(agents!.text).toContain("PROJECT RULES");
		expect(agents!.text).toContain("<workspace-tree>");
	});

	it("renders the active-repo section byte-identical to the legacy base path", async () => {
		const state = fullState();
		const legacy = await buildSystemPrompt({
			cwd: "/project",
			contextFiles: [],
			workspaceTree: workspaceTree(),
			includeWorkspaceTree: false,
			activeRepoContext: state.activeRepoContext,
			skills: [],
			rules: [],
			toolNames: [],
		});
		const legacyText = legacy.systemPrompt.join("\n\n");

		const sections = renderProjectContextSections(state);
		const activeRepo = sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.activeRepo.name);
		expect(activeRepo?.text).toBeDefined();
		expect(legacyText).toContain(activeRepo!.text!.trim());
		expect(activeRepo!.text).toContain("<active-repo-context>");
		expect(activeRepo!.text).toContain("`active-project`");
	});

	it("renders dir-context from discovered AGENTS.md files like the legacy path", async () => {
		const state = fullState({
			contextFiles: [],
			workspaceTree: workspaceTree({ agentsMdFiles: ["/project/nested/AGENTS.md", "/project/AGENTS.md"] }),
		});
		const legacy = await buildSystemPrompt({
			cwd: "/project",
			contextFiles: [],
			workspaceTree: state.workspaceTree,
			includeWorkspaceTree: true,
			skills: [],
			rules: [],
			toolNames: [],
		});
		const legacyText = legacy.systemPrompt.join("\n\n");

		const agents = renderProjectContextSections(state).find(
			section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name,
		);
		expect(agents?.text).toBeDefined();
		expect(agents!.text).toContain("<dir-context>");
		expect(legacyText).toContain(agents!.text!.trim());
	});

	it("omits both sections when there is nothing to render (no empty blocks)", () => {
		const sections = renderProjectContextSections(
			fullState({
				contextFiles: [],
				workspaceTree: workspaceTree({ rendered: "", agentsMdFiles: [] }),
				includeWorkspaceTree: true,
				activeRepoContext: null,
			}),
		);
		for (const section of sections) expect(section.text).toBeUndefined();
	});

	it("omits the workspace tree when the setting is off", () => {
		const sections = renderProjectContextSections(fullState({ includeWorkspaceTree: false }));
		const agents = sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(agents?.text).toBeDefined();
		expect(agents!.text).not.toContain("<workspace-tree>");
		expect(agents!.text).toContain("<repo-rules>");
	});

	it("stays silent for the AGENTS section when the custom-prompt base owns context files", () => {
		const sections = renderProjectContextSections(fullState({ baseOwnsContextFiles: true }));
		const agents = sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(agents?.text).toBeUndefined();
		// The active-repo section stays host-owned in every layout.
		const activeRepo = sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.activeRepo.name);
		expect(activeRepo?.text).toContain("<active-repo-context>");
	});
});

describe("project context host registration", () => {
	it("registers snapshot-cacheable sections under one owner", () => {
		const host = new PromptHost({ owner: "session" });
		const holder = { current: fullState() };
		registerProjectContextSections(host, holder);

		const { sections } = host.assemble({ activeTools: ["read", "glob"] });
		const names = sections.map(section => section.name);
		expect(names).toContain(PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(names).toContain(PROJECT_CONTEXT_SECTIONS.activeRepo.name);
		for (const section of sections) {
			expect(section.owner).toBe(PROJECT_CONTEXT_OWNER);
			expect(section.cacheScope).toBe("snapshot");
		}
	});

	it("replaces rendered content when the discovered state changes (no accumulation)", () => {
		const host = new PromptHost({ owner: "session" });
		const holder = { current: fullState() };
		registerProjectContextSections(host, holder);
		const before = host.assemble().sections.length;

		holder.current = fullState({
			contextFiles: [contextFile("/project/AGENTS.md", "UPDATED RULES")],
		});
		const after = host.assemble();
		expect(after.sections).toHaveLength(before);
		const agents = after.sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(agents?.text).toContain("UPDATED RULES");
		expect(agents?.text).not.toContain("PROJECT RULES");
	});

	it("releases every section at once via the single owner", () => {
		const host = new PromptHost({ owner: "session" });
		registerProjectContextSections(host, { current: fullState() });
		expect(host.assemble().sections.length).toBeGreaterThan(0);

		host.removeByOwner(PROJECT_CONTEXT_OWNER);
		expect(host.assemble().sections).toEqual([]);
	});

	it("resolves the workspace-tree drill-in hint from the active tool wire names", () => {
		const host = new PromptHost({ owner: "session" });
		registerProjectContextSections(host, {
			current: fullState({ workspaceTree: workspaceTree({ truncated: true }) }),
		});
		const { sections } = host.assemble({
			activeTools: ["read", "glob"],
			context: { toolRefs: { glob: "glob", read: "read" } },
		});
		const agents = sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(agents?.text).toContain("use `glob`/`read` to drill in");
	});

	it("keeps {{...}} braces literal in discovered context content (interpolate: false)", () => {
		const host = new PromptHost({ owner: "session" });
		registerProjectContextSections(host, {
			current: fullState({
				contextFiles: [contextFile("/project/AGENTS.md", "BRACES {{not_a_variable}} stay literal")],
			}),
		});
		const agents = host
			.assemble({ activeTools: ["read"] })
			.sections.find(section => section.name === PROJECT_CONTEXT_SECTIONS.agents.name);
		expect(agents?.text).toContain("BRACES {{not_a_variable}} stay literal");
	});
});

describe("project context in a real session", () => {
	let home: string;
	let projectDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-project-ctx-home-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-project-ctx-project-"));
		// Isolate the user-level context discovery so the developer machine's
		// ~/.claude/CLAUDE.md never leaks into the session prompt.
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "PROJECT AGENTS RULES\n\nOnly once.", "utf8");
		// A single direct-child git repo activates the active-repo-context block.
		fs.mkdirSync(path.join(projectDir, "active-project", ".git"), { recursive: true });
		authStorage = await AuthStorage.create(path.join(home, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		authStorage.close();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		for (const dir of [home, projectDir]) fs.rmSync(dir, { recursive: true, force: true });
	});

	async function createProjectSession(overrides: Record<string, unknown> = {}): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: home,
			profileHome: home,
			modelRegistry,
			authStorage,
			sessionManager: SessionManager.inMemory(projectDir),
			settings: Settings.isolated({ "compaction.enabled": false, includeWorkspaceTree: true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...overrides,
		});
		sessions.push(session);
		return session;
	}

	it("carries AGENTS.md, the workspace tree, and active-repo context exactly once each", async () => {
		const session = await createProjectSession();
		const text = session.systemPrompt.join("\n\n");

		expect(text.match(/<repo-rules>/g)).toHaveLength(1);
		expect(text).toContain("PROJECT AGENTS RULES");
		expect(text.match(/<workspace-tree>/g)).toHaveLength(1);
		expect(text.match(/<active-repo-context>/g)).toHaveLength(1);
		expect(text).toContain("`active-project`");
		// The base project block no longer renders the migrated pieces itself.
		const projectBlock = session.systemPrompt.find(block => block.startsWith("PROJECT"));
		expect(projectBlock).toBeDefined();
		expect(projectBlock).not.toContain("<repo-rules>");
		expect(projectBlock).not.toContain("<workspace-tree>");
	});

	it("keeps the pieces absent when discovery finds nothing", async () => {
		fs.rmSync(path.join(projectDir, "AGENTS.md"), { force: true });
		fs.rmSync(path.join(projectDir, "active-project"), { recursive: true, force: true });
		const session = await createProjectSession({ settings: Settings.isolated({ "compaction.enabled": false }) });
		const text = session.systemPrompt.join("\n\n");
		expect(text).not.toContain("<repo-rules>");
		expect(text).not.toContain("<workspace-tree>");
		expect(text).not.toContain("<active-repo-context>");
	});
});
