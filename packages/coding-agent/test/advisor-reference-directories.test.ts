import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";

const REFERENCE_TOKEN = "M57_REFERENCE_TOKEN_7c1";

function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
	return result.content
		.flatMap(block => {
			const text = (block as { type: string; text?: string }).text;
			return block.type === "text" && text ? [text] : [];
		})
		.join("\n");
}

describe("advisor reference directories", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		await Bun.sleep(0);
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
	});

	async function withAdvisorSession(
		run: (context: {
			session: AgentSession;
			sessionManager: SessionManager;
			referenceDir: string;
			referenceFile: string;
		}) => Promise<void>,
		options: { seedAdditionalDirectoriesAtCreate?: boolean } = {},
	): Promise<void> {
		const tempDir = TempDir.createSync("@pi-advisor-reference-dirs-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		const referenceDir = tempDir.join("references");
		const referenceFile = path.join(referenceDir, "notes", "shared.md");
		fs.mkdirSync(path.join(referenceDir, "notes"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(referenceFile, `# Shared notes\n${REFERENCE_TOKEN}\n`, "utf8");

		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
			const result = await createAgentSession({
				cwd,
				...(options.seedAdditionalDirectoriesAtCreate === false ? {} : { additionalDirectories: [referenceDir] }),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: (() => {
					const s = Settings.isolated({
						"async.enabled": false,
						"advisor.enabled": true,
					});
					s.setModelRole("advisor", "openai/gpt-4o-mini");
					return s;
				})(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.isAdvisorActive()).toBe(true);
			await run({ session, sessionManager, referenceDir, referenceFile });
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	}

	it("names every additional workspace root in the advisor system prompt", async () => {
		await withAdvisorSession(async ({ session, referenceDir }) => {
			const dump = session.formatAdvisorHistoryAsText();
			expect(dump).not.toBeNull();
			expect(dump).toContain("<workspace-roots>");
			expect(dump).toContain(`- ${referenceDir}`);
			expect(dump).toContain("NEVER report them as missing or absent");
		});
	}, 30_000);

	it("lets the advisor's read tool open a file inside an additional workspace root", async () => {
		await withAdvisorSession(async ({ session, referenceFile }) => {
			const read = session.getAdvisorAgent()?.state.tools.find(tool => tool.name === "read");
			if (!read) throw new Error("Advisor read tool was not available.");
			const result = await read.execute("advisor-read-reference", { path: referenceFile });
			expect(textOf(result)).toContain(REFERENCE_TOKEN);
		});
	}, 30_000);

	it("lets the advisor's grep and glob tools search an additional workspace root", async () => {
		await withAdvisorSession(async ({ session, referenceDir }) => {
			const tools = session.getAdvisorAgent()?.state.tools ?? [];
			const grep = tools.find(tool => tool.name === "grep");
			const glob = tools.find(tool => tool.name === "glob");
			if (!grep) throw new Error("Advisor grep tool was not available.");
			if (!glob) throw new Error("Advisor glob tool was not available.");

			const grepResult = await grep.execute("advisor-grep-reference", {
				pattern: REFERENCE_TOKEN,
				path: referenceDir,
			});
			expect(textOf(grepResult)).toContain("shared.md");

			const globResult = await glob.execute("advisor-glob-reference", {
				path: `${referenceDir.replaceAll("\\", "/")}/**/*.md`,
			});
			expect(textOf(globResult)).toContain("shared.md");
		});
	}, 30_000);

	it("refreshes the advisor prompt when the daemon seeds project roots after creation", async () => {
		await withAdvisorSession(
			async ({ session, sessionManager, referenceDir }) => {
				// Daemon order: create with preloaded contextFiles, then merge the
				// project's source folders into the SessionManager and refresh.
				await sessionManager.setAdditionalDirectories([referenceDir]);
				await session.refreshSkills();
				// A second rebuild replaces the block instead of appending a copy.
				await session.refreshSkills();

				const advisorDump = session.formatAdvisorHistoryAsText();
				expect(advisorDump).not.toBeNull();
				expect(advisorDump?.match(/<workspace-roots>/g)).toHaveLength(1);
				expect(advisorDump).toContain(`- ${referenceDir}`);

				const primaryDump = session.formatSessionAsText();
				expect(primaryDump.match(/<workspace-roots>/g)).toHaveLength(1);
				expect(primaryDump).toContain(`- ${referenceDir}`);

				// Removing the root drops the stale list rather than keeping it.
				await sessionManager.setAdditionalDirectories([]);
				await session.refreshSkills();
				const afterRemoval = session.formatAdvisorHistoryAsText();
				expect(afterRemoval).not.toContain("<workspace-roots>");
				expect(afterRemoval).not.toContain(referenceDir);
			},
			{ seedAdditionalDirectoriesAtCreate: false },
		);
	}, 30_000);
});
