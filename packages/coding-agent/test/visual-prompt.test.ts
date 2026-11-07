import { beforeAll, describe, expect, it } from "bun:test";
import { WidgetTool } from "../src/bundled-plugins/visuals/tool";
import { WIDGET_RENDER_WHEN } from "../src/bundled-plugins/visuals/when";
import { Settings } from "../src/config/settings";
import { buildSystemPrompt } from "../src/system-prompt";

/**
 * A visualization the model never calls is dead UI. The "when to render"
 * rule used to exist only in the tool description; an agent asked for a
 * per-package line breakdown answered with a list and drew the chart only
 * when asked. These tests pin the fix: ONE wording, shipped through BOTH
 * channels the model actually reads, and only when the tool is mounted.
 */

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

async function promptWithTools(toolNames: string[]): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		contextFiles: [],
		skills: [],
		toolNames,
		workspaceTree,
	});
	return systemPrompt.join("\n");
}

describe("visual-answer prompt guidance", () => {
	it("the system prompt carries the same rule as the tool description", async () => {
		const prompt = await promptWithTools(["read", "bash", "edit", "write", "widget"]);
		expect(prompt).toContain("# Visual answers");
		expect(prompt).toContain("SHOULD reach for it without being asked");
		expect(prompt).toContain(WIDGET_RENDER_WHEN);
		expect(new WidgetTool().description).toContain(WIDGET_RENDER_WHEN);
	});

	it("no guidance when the widget tool is not mounted", async () => {
		const prompt = await promptWithTools(["read", "bash", "edit", "write"]);
		expect(prompt).not.toContain("# Visual answers");
		expect(prompt).not.toContain(WIDGET_RENDER_WHEN);
	});

	it("the prompt.md marker is expanded, never shown to the model", () => {
		const description = new WidgetTool().description;
		expect(description).not.toContain("WIDGET_RENDER_WHEN:");
		expect(description).not.toContain("<!--");
	});

	it("the rule keeps its anti-abuse limits", () => {
		expect(WIDGET_RENDER_WHEN).toContain("Do not use it for a few numbers");
		expect(WIDGET_RENDER_WHEN).toContain("At most one page per answer");
		expect(WIDGET_RENDER_WHEN).toContain("never restate what the widget already shows");
	});
});
