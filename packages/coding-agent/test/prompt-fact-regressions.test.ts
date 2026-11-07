/**
 * Regression anchors for prompt facts the model can only learn from prompt text:
 * the managed-skill directory, the widget theme class names, an unreachable
 * version-control branch in the custom-prompt template, and dead `§` markers.
 *
 * Each assertion exercises the text as a consumer receives it (guidance builder,
 * tool description, rendered template), not a synonym of the source file.
 */
import { describe, expect, it } from "bun:test";
import { buildAutoLearnInstructions } from "@musepi/pi-coding-agent/autolearn/controller";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { LearnTool } from "@musepi/pi-coding-agent/tools/learn";
import { ManageSkillTool } from "@musepi/pi-coding-agent/tools/manage-skill";
import { prompt } from "@musepi/pi-utils";
import widgetDescription from "../src/bundled-plugins/visuals/prompt.md" with { type: "text" };
import customSystemPromptTemplate from "../src/prompts/system/custom-system-prompt.md" with { type: "text" };
import subagentSystemPromptTemplate from "../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import systemPromptTemplate from "../src/prompts/system/system-prompt.md" with { type: "text" };

function makeSession(settingsOverrides: Partial<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp/prompt-fact-regressions",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settingsOverrides),
	};
}

describe("managed-skill prompt facts", () => {
	it("auto-learn guidance names the real managed and authored skill roots", () => {
		const guidance = buildAutoLearnInstructions({ manageSkill: true, learn: true });
		expect(guidance).not.toBeNull();
		expect(guidance).toContain("~/.musepi/agent/managed-skills");
		expect(guidance).toContain("~/.musepi/agent/skills");
		expect(guidance).not.toContain("~/.omp");
	});

	it("learn tool description names the real managed-skills root", () => {
		const learn = LearnTool.createIf(makeSession({ "autolearn.enabled": true, "memory.backend": "local" }));
		expect(learn).not.toBeNull();
		expect(learn?.description).toContain("~/.musepi/agent/managed-skills");
		expect(learn?.description).not.toContain("~/.omp");
	});

	it("manage_skill tool description names the real managed-skills root", () => {
		const manageSkill = ManageSkillTool.createIf(makeSession({ "autolearn.enabled": true }));
		expect(manageSkill).not.toBeNull();
		expect(manageSkill?.description).toContain("~/.musepi/agent/managed-skills");
		expect(manageSkill?.description).not.toContain("~/.omp");
	});
});

describe("widget prompt facts", () => {
	it("names the theme classes the host actually injects", () => {
		const text = prompt.render(widgetDescription, {});
		expect(text).toContain("musepi-theme-dark");
		expect(text).toContain("musepi-theme-light");
		expect(text).not.toContain("omp-theme-");
	});
});

describe("custom system prompt template facts", () => {
	it("renders custom prompt and context without an unreachable version-control branch", () => {
		const source = customSystemPromptTemplate;
		expect(source).not.toContain("git.isRepo");
		expect(source).not.toContain("Version Control");

		const rendered = prompt.render(source, {
			customPrompt: "Base prompt",
			contextFiles: [{ path: "AGENTS.md", content: "Project context", depth: 0 }],
			skills: [],
			rules: [],
			alwaysApplyRules: [],
		});
		expect(rendered).toContain("Base prompt");
		expect(rendered).toContain("Project context");
		expect(rendered).not.toContain("Version Control");
	});
});

describe("system prompt section markers", () => {
	it("core system prompt has no bare § markers", () => {
		expect(systemPromptTemplate).not.toContain("§");

		const rendered = prompt.render(systemPromptTemplate, { tools: [], toolRefs: {} });
		expect(rendered).not.toContain("§");
		expect(rendered).toContain("USER SLASH COMMANDS");
		expect(rendered).toContain("/compact");
		expect(rendered).toContain("DELIVERY CONTRACT");
	});

	it("names <advisory> as the advisor's voice, not the user's", () => {
		// A note reaches the model as a `developer` message, and any provider
		// without a mid-conversation developer/system slot collapses that to a
		// plain user message (compat: `supportsDeveloperRole = isOpenAIHost ||
		// isAzureHost`). The tag is then the ONLY thing carrying its origin, so
		// the conventions block must define it — otherwise the primary answers
		// the note as if the user had typed it.
		const rendered = prompt.render(systemPromptTemplate, { tools: [], toolRefs: {} });
		expect(rendered).toContain("<advisory>");
		expect(rendered).toMatch(/NEVER the user/);
		expect(rendered).toMatch(/NEVER authoritative/);
	});

	it("subagent system prompt has no bare § markers", () => {
		expect(subagentSystemPromptTemplate).not.toContain("§");

		const rendered = prompt.render(subagentSystemPromptTemplate, { agent: "test-agent" });
		expect(rendered).not.toContain("§");
		expect(rendered).toContain("Completion");
		expect(rendered).toContain("Yield protocol");
	});
});
