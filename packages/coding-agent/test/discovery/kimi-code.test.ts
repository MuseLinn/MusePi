import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@musepi/pi-coding-agent/capability/mcp";
import { type Skill, skillCapability } from "@musepi/pi-coding-agent/capability/skill";
import { type SlashCommand, slashCommandCapability } from "@musepi/pi-coding-agent/capability/slash-command";
import { loadCapability } from "@musepi/pi-coding-agent/discovery";
import { removeWithRetries } from "@musepi/pi-utils";

let tempHome = "";
let tempCwd = "";
let kimiHome = "";
let originalHome: string | undefined;
let originalKimiHome: string | undefined;
let originalToken: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(async () => {
	originalHome = process.env.HOME;
	originalKimiHome = process.env.KIMI_CODE_HOME;
	originalToken = process.env.MUSEPI_KIMI_TEST_TOKEN;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-kimi-home-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-kimi-cwd-"));
	kimiHome = path.join(tempHome, "relocated-kimi");
	process.env.HOME = tempHome;
	process.env.KIMI_CODE_HOME = kimiHome;
	process.env.MUSEPI_KIMI_TEST_TOKEN = "resolved-token";
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
});

afterEach(async () => {
	vi.restoreAllMocks();
	restoreEnv("HOME", originalHome);
	restoreEnv("KIMI_CODE_HOME", originalKimiHome);
	restoreEnv("MUSEPI_KIMI_TEST_TOKEN", originalToken);
	await removeWithRetries(tempHome);
	await removeWithRetries(tempCwd);
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value));
}

async function loadMcp(suppress = false): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd: tempCwd,
		providers: ["kimi-code"],
		...(suppress && { suppress: (server: MCPServer) => server.enabled === false }),
	});
	return result.items;
}

describe("Kimi Code MCP discovery", () => {
	test("loads relocated user and project stdio, HTTP and SSE entries", async () => {
		await writeJson(path.join(kimiHome, "mcp.json"), {
			mcpServers: {
				local: {
					command: "npx",
					args: ["server", "${MUSEPI_KIMI_TEST_TOKEN:-fallback}"],
					env: { TOKEN: "${MUSEPI_KIMI_TEST_TOKEN}" },
					startupTimeoutMs: 12000,
				},
				remote: {
					url: "https://example.com/mcp",
					bearerTokenEnvVar: "MUSEPI_KIMI_TEST_TOKEN",
				},
			},
		});
		await writeJson(path.join(tempCwd, ".kimi-code", "mcp.json"), {
			mcpServers: {
				events: { transport: "sse", url: "https://example.com/sse" },
				disabled: { command: "disabled-server", enabled: false },
			},
		});

		const servers = await loadMcp();
		const local = servers.find(server => server.name === "local");
		const remote = servers.find(server => server.name === "remote");
		expect(local?.transport).toBe("stdio");
		expect(local?.args).toEqual(["server", "resolved-token"]);
		expect(local?.env).toEqual({ TOKEN: "resolved-token" });
		expect(local?.timeout).toBe(12000);
		expect(local?._source.path).toBe(path.join(kimiHome, "mcp.json"));
		expect(remote?.transport).toBe("http");
		expect(remote?.headers).toEqual({ Authorization: "Bearer resolved-token" });
		expect(servers.find(server => server.name === "events")?.transport).toBe("sse");
		expect(servers.find(server => server.name === "disabled")?.enabled).toBe(false);
	});

	test("a disabled project server suppresses the same-named user server", async () => {
		await writeJson(path.join(kimiHome, "mcp.json"), {
			mcpServers: { shared: { command: "user-server" } },
		});
		await writeJson(path.join(tempCwd, ".kimi-code", "mcp.json"), {
			mcpServers: { shared: { command: "project-server", enabled: false } },
		});

		expect((await loadMcp(true)).find(server => server.name === "shared")).toBeUndefined();
	});

	test("invalid JSON produces a warning without blocking valid entries", async () => {
		await fs.mkdir(kimiHome, { recursive: true });
		await fs.writeFile(path.join(kimiHome, "mcp.json"), "{broken");
		await writeJson(path.join(tempCwd, ".kimi-code", "mcp.json"), {
			mcpServers: { valid: { command: "valid-server" } },
		});

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempCwd,
			providers: ["kimi-code"],
		});
		expect(result.items.map(server => server.name)).toContain("valid");
		expect(result.warnings?.some(warning => warning.includes("mcp.json"))).toBe(true);
	});
});

describe("Kimi Code skills and installed plugins", () => {
	test("loads user and project skills", async () => {
		const userSkill = path.join(kimiHome, "skills", "user-workflow", "SKILL.md");
		const projectSkill = path.join(tempCwd, ".kimi-code", "skills", "project-workflow", "SKILL.md");
		await writeJson(path.join(kimiHome, "config.toml"), {});
		await fs.mkdir(path.dirname(userSkill), { recursive: true });
		await fs.mkdir(path.dirname(projectSkill), { recursive: true });
		await fs.writeFile(userSkill, "---\ndescription: User workflow\n---\nUser skill body\n");
		await fs.writeFile(projectSkill, "---\ndescription: Project workflow\n---\nProject skill body\n");

		const result = await loadCapability<Skill>(skillCapability.id, {
			cwd: tempCwd,
			providers: ["kimi-code"],
		});
		expect(result.items.map(skill => skill.name)).toEqual(["project-workflow", "user-workflow"]);
	});

	test("loads enabled plugin skills, commands and MCP with native names and overrides", async () => {
		const root = path.join(kimiHome, "plugins", "managed", "finance");
		await writeJson(path.join(root, "kimi.plugin.json"), {
			name: "finance",
			skills: "./skills/",
			commands: "./commands/",
			mcpServers: {
				local: { command: "./bin/server", cwd: "./", args: ["serve"] },
				remote: { url: "https://example.com/mcp", enabled: false },
			},
		});
		const skillPath = path.join(root, "skills", "review", "SKILL.md");
		await fs.mkdir(path.dirname(skillPath), { recursive: true });
		await fs.writeFile(skillPath, "---\ndescription: Review finances\n---\nReview skill body\n");
		await fs.mkdir(path.join(root, "commands"), { recursive: true });
		await fs.writeFile(
			path.join(root, "commands", "report.md"),
			"---\ndescription: Financial report\n---\nReport on $ARGUMENTS\n",
		);
		await writeJson(path.join(kimiHome, "plugins", "installed.json"), {
			version: 1,
			plugins: [
				{
					id: "finance",
					root,
					source: "local-path",
					enabled: true,
					installedAt: "2026-01-01T00:00:00Z",
					capabilities: { mcpServers: { local: { enabled: false } } },
				},
			],
		});

		const [skills, commands, servers] = await Promise.all([
			loadCapability<Skill>(skillCapability.id, { cwd: tempCwd, providers: ["kimi-code"] }),
			loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: tempCwd, providers: ["kimi-code"] }),
			loadMcp(),
		]);
		expect(skills.items.map(skill => skill.name)).toEqual(["finance:review"]);
		expect(commands.items.map(command => command.name)).toEqual(["finance:report"]);
		expect(commands.items[0]?.content).toBe("Report on $ARGUMENTS");
		const local = servers.find(server => server.name === "plugin-finance:local");
		expect(local?.command).toBe(path.join(root, "bin", "server"));
		expect(local?.cwd).toBe(root);
		expect(local?.enabled).toBe(false);
		expect(servers.find(server => server.name === "plugin-finance:remote")?.enabled).toBe(false);
	});

	test("loads PATH executables and single-file commands from enabled plugins", async () => {
		const root = path.join(kimiHome, "plugins", "managed", "single-file");
		await writeJson(path.join(root, "kimi.plugin.json"), {
			name: "single-file",
			commands: "./review.md",
			mcpServers: { local: { command: "npx", args: ["example-server"] } },
		});
		await fs.writeFile(path.join(root, "review.md"), "---\ndescription: Review\n---\nReview $ARGUMENTS\n");
		await writeJson(path.join(kimiHome, "plugins", "installed.json"), {
			version: 1,
			plugins: [{ id: "single-file", root, source: "local-path", enabled: true, installedAt: "now" }],
		});

		const [commands, servers] = await Promise.all([
			loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: tempCwd, providers: ["kimi-code"] }),
			loadMcp(),
		]);
		expect(commands.items.map(command => command.name)).toEqual(["single-file:review"]);
		expect(servers.find(server => server.name === "plugin-single-file:local")?.command).toBe("npx");
	});

	test("disabled plugins contribute nothing", async () => {
		const root = path.join(kimiHome, "plugins", "managed", "disabled");
		await writeJson(path.join(root, "kimi.plugin.json"), {
			name: "disabled",
			mcpServers: { server: { command: "should-not-load" } },
		});
		await writeJson(path.join(kimiHome, "plugins", "installed.json"), {
			version: 1,
			plugins: [{ id: "disabled", root, source: "local-path", enabled: false, installedAt: "now" }],
		});

		expect((await loadMcp()).find(server => server.name === "plugin-disabled:server")).toBeUndefined();
	});
});
