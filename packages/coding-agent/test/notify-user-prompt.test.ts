import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { buildSystemPrompt } from "../src/system-prompt";

/**
 * Progress updates gate on the tool being mounted: a prompt that tells the
 * agent to post updates while the tool is absent is an instruction it cannot
 * follow, and the tool without the prompt leaves long runs silent.
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

describe("progress-update prompt guidance", () => {
	it("names the tool and its boundaries when the tool is mounted", async () => {
		const prompt = await promptWithTools(["read", "bash", "notify_user"]);
		expect(prompt).toContain("# Progress Updates");
		expect(prompt).toContain("`notify_user`");
		expect(prompt).toContain("NEVER repeat unchanged status");
	});

	it("stays out of prompts that cannot call the tool", async () => {
		const prompt = await promptWithTools(["read", "bash"]);
		expect(prompt).not.toContain("# Progress Updates");
	});
});
