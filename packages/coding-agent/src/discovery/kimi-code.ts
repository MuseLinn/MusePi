/** Kimi Code CLI discovery for its native skills, plugins, and MCP configuration. */
import * as path from "node:path";
import { parseFrontmatter } from "@musepi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { isContainedResolved, realpathIfExists, resolveContainedPath } from "./contained-path";
import { createSourceMeta, expandEnvVarsDeep, loadFilesFromDir, scanSkillsFromDir } from "./helpers";
import { resolvePluginStdioPaths } from "./substitute-plugin-root";

const PROVIDER_ID = "kimi-code";
const DISPLAY_NAME = "Kimi Code";
const PRIORITY = 78;

interface KimiInstalledRecord {
	id: string;
	root: string;
	enabled: boolean;
	capabilities?: {
		mcpServers?: Record<string, { enabled?: boolean }>;
	};
}

interface KimiPlugin {
	record: KimiInstalledRecord;
	root: string;
	manifestPath: string;
	manifest: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kimiHome(ctx: LoadContext): string {
	const override = process.env.KIMI_CODE_HOME?.trim();
	return override ? path.resolve(override) : path.join(ctx.home, ".kimi-code");
}

async function readJson(filePath: string): Promise<{ value?: unknown; warning?: string }> {
	const raw = await readFile(filePath);
	if (raw === null) return {};
	try {
		return { value: JSON.parse(raw) as unknown };
	} catch (error) {
		return { warning: `[kimi-code] Invalid JSON in ${filePath}: ${String(error)}` };
	}
}

function stringPaths(value: unknown): string[] {
	const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return entries.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("./"));
}

async function loadPlugins(ctx: LoadContext): Promise<{ plugins: KimiPlugin[]; warnings: string[] }> {
	const registryPath = path.join(kimiHome(ctx), "plugins", "installed.json");
	const parsed = await readJson(registryPath);
	const warnings = parsed.warning ? [parsed.warning] : [];
	if (!isRecord(parsed.value) || !Array.isArray(parsed.value.plugins)) return { plugins: [], warnings };

	const plugins: KimiPlugin[] = [];
	for (const candidate of parsed.value.plugins) {
		if (!isRecord(candidate)) continue;
		if (
			typeof candidate.id !== "string" ||
			typeof candidate.root !== "string" ||
			typeof candidate.enabled !== "boolean"
		) {
			warnings.push(`[kimi-code] Ignoring malformed plugin record in ${registryPath}`);
			continue;
		}
		if (!candidate.enabled) continue;
		const record = candidate as unknown as KimiInstalledRecord;
		const root = await realpathIfExists(record.root);
		if (root === null) {
			warnings.push(`[kimi-code] Plugin ${record.id} root is unavailable: ${record.root}`);
			continue;
		}

		let manifest: Record<string, unknown> | undefined;
		let manifestPath = "";
		for (const candidatePath of [
			path.join(root, "kimi.plugin.json"),
			path.join(root, ".kimi-plugin", "plugin.json"),
		]) {
			const contained = await resolveContainedPath(root, candidatePath);
			if (contained.status === "outside") {
				warnings.push(`[kimi-code] Plugin ${record.id} manifest resolves outside its root`);
				continue;
			}
			if (contained.status === "missing") continue;
			const parsedManifest = await readJson(contained.realPath);
			if (parsedManifest.warning) {
				warnings.push(parsedManifest.warning);
				continue;
			}
			if (!isRecord(parsedManifest.value) || typeof parsedManifest.value.name !== "string") {
				warnings.push(`[kimi-code] Invalid plugin manifest for ${record.id}: ${contained.realPath}`);
				continue;
			}
			manifest = parsedManifest.value;
			manifestPath = contained.realPath;
			break;
		}
		if (manifest) plugins.push({ record, root, manifestPath, manifest });
	}
	return { plugins, warnings };
}

interface MCParseOptions {
	sourcePath: string;
	level: "user" | "project";
	baseDir: string;
	namespace?: string;
	pluginRoot?: string;
	capabilityState?: Record<string, { enabled?: boolean }>;
}

async function parseServers(value: unknown, options: MCParseOptions): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];
	if (!isRecord(value)) return { items, warnings };

	for (const [serverName, candidate] of Object.entries(value)) {
		if (!isRecord(candidate)) {
			warnings.push(`[kimi-code] Skipping malformed MCP server ${serverName} in ${options.sourcePath}`);
			continue;
		}
		const config = expandEnvVarsDeep(candidate);
		if (typeof config.command !== "string" && typeof config.url !== "string") {
			warnings.push(`[kimi-code] Skipping MCP server ${serverName}: missing command or url`);
			continue;
		}
		if (options.pluginRoot && typeof config.cwd === "string" && !config.cwd.startsWith("./")) {
			warnings.push(`[kimi-code] Skipping MCP server ${serverName}: plugin cwd must start with ./`);
			continue;
		}

		const rooted = resolvePluginStdioPaths(
			{
				command: typeof config.command === "string" ? config.command : undefined,
				cwd: typeof config.cwd === "string" ? config.cwd : undefined,
			},
			options.baseDir,
		);
		const commandNeedsContainment =
			typeof config.command === "string" && (path.isAbsolute(config.command) || /^\.?[/\\]/.test(config.command));
		if (
			options.pluginRoot &&
			((commandNeedsContainment && !(await isContainedResolved(options.pluginRoot, rooted.command as string))) ||
				(rooted.cwd && !(await isContainedResolved(options.pluginRoot, rooted.cwd))))
		) {
			warnings.push(`[kimi-code] Skipping MCP server ${serverName}: stdio path escapes the plugin root`);
			continue;
		}

		const headers = isRecord(config.headers)
			? Object.fromEntries(
					Object.entries(config.headers).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
		if (typeof config.bearerTokenEnvVar === "string") {
			const token = Bun.env[config.bearerTokenEnvVar];
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		const transport =
			config.transport === "stdio" || config.transport === "http" || config.transport === "sse"
				? config.transport
				: typeof config.command === "string"
					? "stdio"
					: "http";
		const enabled = options.capabilityState?.[serverName]?.enabled ?? config.enabled;
		items.push({
			name: options.namespace ? `${options.namespace}${serverName}` : serverName,
			...(typeof enabled === "boolean" && { enabled }),
			...(typeof config.startupTimeoutMs === "number" && { timeout: config.startupTimeoutMs }),
			...(rooted.command !== undefined && { command: rooted.command }),
			...(Array.isArray(config.args) && {
				args: config.args.filter((arg): arg is string => typeof arg === "string"),
			}),
			...(isRecord(config.env) && {
				env: Object.fromEntries(
					Object.entries(config.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				),
			}),
			...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
			...(options.pluginRoot && transport === "stdio" && rooted.cwd === undefined && { cwd: options.pluginRoot }),
			...(typeof config.url === "string" && { url: config.url }),
			...(Object.keys(headers).length > 0 && { headers }),
			transport,
			_source: createSourceMeta(PROVIDER_ID, options.sourcePath, options.level),
		});
	}
	return { items, warnings };
}

async function loadDirectMcp(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];
	const sources = [
		{ filePath: path.join(ctx.cwd, ".kimi-code", "mcp.json"), level: "project" as const },
		{ filePath: path.join(kimiHome(ctx), "mcp.json"), level: "user" as const },
	];
	for (const source of sources) {
		const parsed = await readJson(source.filePath);
		if (parsed.warning) warnings.push(parsed.warning);
		if (!isRecord(parsed.value)) continue;
		const result = await parseServers(parsed.value.mcpServers, {
			sourcePath: source.filePath,
			level: source.level,
			baseDir: path.dirname(source.filePath),
		});
		items.push(...result.items);
		warnings.push(...(result.warnings ?? []));
	}
	return { items, warnings };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const direct = await loadDirectMcp(ctx);
	const { plugins, warnings } = await loadPlugins(ctx);
	const items = [...direct.items];
	const allWarnings = [...(direct.warnings ?? []), ...warnings];
	for (const plugin of plugins) {
		const result = await parseServers(plugin.manifest.mcpServers, {
			sourcePath: plugin.manifestPath,
			level: "user",
			baseDir: plugin.root,
			namespace: `plugin-${plugin.record.id}:`,
			pluginRoot: plugin.root,
			capabilityState: plugin.record.capabilities?.mcpServers,
		});
		items.push(...result.items);
		allWarnings.push(...(result.warnings ?? []));
	}
	return { items, warnings: allWarnings };
}

async function resolvePluginPaths(plugin: KimiPlugin, field: "skills" | "commands"): Promise<string[]> {
	const values = stringPaths(plugin.manifest[field]);
	const paths: string[] = [];
	for (const value of values) {
		const resolved = await resolveContainedPath(plugin.root, path.resolve(plugin.root, value));
		if (resolved.status === "ok") paths.push(resolved.realPath);
	}
	return paths;
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const scans = await Promise.all([
		scanSkillsFromDir(ctx, {
			dir: path.join(ctx.cwd, ".kimi-code", "skills"),
			providerId: PROVIDER_ID,
			level: "project",
		}),
		scanSkillsFromDir(ctx, {
			dir: path.join(kimiHome(ctx), "skills"),
			providerId: PROVIDER_ID,
			level: "user",
		}),
	]);
	const items = scans.flatMap(scan => scan.items);
	const warnings = scans.flatMap(scan => scan.warnings ?? []);
	const { plugins, warnings: pluginWarnings } = await loadPlugins(ctx);
	warnings.push(...pluginWarnings);

	for (const plugin of plugins) {
		const declared = stringPaths(plugin.manifest.skills);
		if (declared.length === 0) {
			const rootSkill = await resolveContainedPath(plugin.root, path.join(plugin.root, "SKILL.md"));
			if (rootSkill.status !== "ok") continue;
			const content = await readFile(rootSkill.realPath);
			if (content === null) continue;
			const { frontmatter, body } = parseFrontmatter(content, { source: rootSkill.realPath });
			const name = typeof frontmatter.name === "string" ? frontmatter.name : plugin.record.id;
			items.push({
				name: `${plugin.record.id}:${name}`,
				path: rootSkill.realPath,
				content: body,
				frontmatter,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, rootSkill.realPath, "user"),
			});
			continue;
		}
		for (const dir of await resolvePluginPaths(plugin, "skills")) {
			const result = await scanSkillsFromDir(ctx, {
				dir,
				providerId: PROVIDER_ID,
				level: "user",
				includeSelf: true,
			});
			items.push(
				...result.items.map(skill => ({
					...skill,
					name: `${plugin.record.id}:${skill.name}`,
				})),
			);
			warnings.push(...(result.warnings ?? []));
		}
	}
	return { items, warnings };
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const { plugins, warnings } = await loadPlugins(ctx);
	for (const plugin of plugins) {
		for (const commandPath of await resolvePluginPaths(plugin, "commands")) {
			const transform = (name: string, content: string, filePath: string, source: SourceMeta): SlashCommand => {
				const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
				const relativeName = path.relative(commandPath, filePath).replace(/\.md$/, "").replaceAll(path.sep, "/");
				const fallbackName = (relativeName || name).replace(/\.md$/, "");
				const commandName = typeof frontmatter.name === "string" ? frontmatter.name : fallbackName;
				return {
					name: `${plugin.record.id}:${commandName}`,
					path: filePath,
					content: body,
					level: "user",
					_source: source,
				};
			};
			if (commandPath.endsWith(".md")) {
				const content = await readFile(commandPath);
				if (content !== null) {
					items.push(
						transform(
							path.basename(commandPath),
							content,
							commandPath,
							createSourceMeta(PROVIDER_ID, commandPath, "user"),
						),
					);
					continue;
				}
			}
			const result = await loadFilesFromDir<SlashCommand>(ctx, commandPath, PROVIDER_ID, "user", {
				extensions: ["md"],
				recursive: true,
				transform,
			});
			items.push(...result.items);
			warnings.push(...(result.warnings ?? []));
		}
	}
	return { items, warnings };
}

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load Kimi Code user, project, and installed-plugin MCP servers",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load Kimi Code user, project, and installed-plugin skills",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from installed Kimi Code plugins",
	priority: PRIORITY,
	load: loadSlashCommands,
});
