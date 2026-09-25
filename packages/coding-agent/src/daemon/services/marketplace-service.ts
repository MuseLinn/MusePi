import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { MANAGED_SKILLS_PROVIDER_ID } from "../../autolearn/managed-skills";
import type { Settings } from "../../config/settings";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import type { Extension } from "../../extensibility/extensions-center/types";
import type { DaemonService } from "./types";

/**
 * MarketplaceService — marketplace/skills 控制面（L2 宿主服务，P1 第十二刀抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `marketplace.list` / `marketplace.install` / `marketplace.remove`
 *   （GUI 商店面板：目录浏览/安装/移除）、`skills.list` / `skills.delete` /
 *   `skills.install` / `skills.read`（技能扫描/删除/git 安装/源码读取）与
 *   `skills.marketplace.query` / `skills.marketplace.categories` /
 *   `skills.marketplace.featured` / `skills.marketplace.detail`（远程技能
 *   市场 SkillHub/skills.sh）。
 * - 输出：各 RPC 返回值原样；两个 10s TTL 缓存（#marketplaceCache/
 *   #skillsCache）随变更 RPC 与宿主 watcher 失效；extensions.changed 广播
 *   经注入的 onChanged 扇出（宿主侧接 EventService，lazy 调用无循环）。
 * - 生命周期：无 start/stop——缓存惰性构建；宿主扩展 watcher 经
 *   invalidateSkillsCache 失效技能扫描，加载/卸载可逆。
 *
 * 范围边界（有意不包，P1 纪律）：
 * - `context.list`（skills + context 统一视图的 context 半边）原地留宿主；
 *   marketplace 管理器（plugins/marketplace）、远程市场客户端
 *   （skills/marketplace-client）与 git 安装器（skills/install）本体原地
 *   保留，本服务只调用。
 *
 * 从 server.ts 巨型 switch 的十一个 case 与 #marketplaceCache/
 * #buildMarketplaceManager/#skillsCache/#getSkills 原样搬移（P1 纪律：
 * 纯搬移不改行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。
 */

/** One skill entry served by skills.list (scan + enablement state). */
export interface SkillListItem {
	name: string;
	description: string;
	filePath: string;
	source: string;
	hide: boolean;
	/** Virtual skills declared by extensions (registerSkill) carry their
	 *  markdown body here instead of a file (filePath === ""). */
	content?: string;
	_source?: { provider: string; providerName: string; path: string; level: "user" | "project" | "native" };
}

export interface MarketplaceServiceDeps {
	cwd(): string;
	settings(): Settings | null;
	/** #getSkills 合并扩展虚拟技能用（宿主接 ExtensionService.getExtensions）。 */
	extensionEntries(): Promise<Extension[]>;
	/** skills.delete/install 的扩展缓存失效（宿主接 ExtensionService.invalidateExtensionsCache）。 */
	invalidateExtensionsCache(): void;
	/** marketplace.install/remove 的插件双缓存失效（宿主接 ExtensionService.invalidatePluginCaches）。 */
	invalidatePluginCaches(): void;
	/** extensions.changed 广播（宿主接 EventService）。 */
	onChanged(): void;
}

export class MarketplaceService implements DaemonService {
	readonly key = "marketplace";
	readonly routes = {
		"marketplace.list": "list",
		"marketplace.install": "install",
		"marketplace.remove": "remove",
		"skills.list": "listSkills",
		"skills.delete": "deleteSkill",
		"skills.install": "installSkill",
		"skills.read": "readSkill",
		"skills.marketplace.query": "querySkillMarket",
		"skills.marketplace.categories": "skillCategories",
		"skills.marketplace.featured": "featuredSkills",
		"skills.marketplace.detail": "skillDetail",
	} as const;

	readonly #deps: MarketplaceServiceDeps;

	/** TTL cache of the marketplace catalog browse (settings → marketplace
	 *  tab). Combines {@link MarketplaceManager.listAvailablePlugins}
	 *  output with per-plugin `installed`/`installedScope` flags so the GUI
	 *  renders Install/Remove affordances without a second round-trip.
	 *  Busted on install/remove mutations. */
	#marketplaceCache: {
		at: number;
		entries: {
			name: string;
			marketplace: string;
			version?: string;
			description?: string;
			author?: string;
			category?: string;
			tags?: readonly string[];
			homepage?: string;
			repository?: string;
			license?: string;
			icon?: string;
			installed: boolean;
			installedScope: "user" | "project" | null;
		}[];
	} | null = null;

	/** TTL cache of the skills scan (settings → skills tab + slash
	 *  completion). */
	#skillsCache: {
		at: number;
		skills: SkillListItem[];
		warnings: string[];
	} | null = null;

	constructor(deps: MarketplaceServiceDeps) {
		this.#deps = deps;
	}

	/** Build a `MarketplaceManager` wired to the host's cwd and the global
	 *  registry/cache dirs. Reused by the marketplace RPCs so the path
	 *  resolution stays consistent with the TUI /marketplace flow. */
	async #buildMarketplaceManager() {
		const m = await import("../../extensibility/plugins/marketplace");
		const {
			getInstalledPluginsRegistryPath,
			getMarketplacesCacheDir,
			getMarketplacesRegistryPath,
			getPluginsCacheDir,
			MarketplaceManager,
		} = m;
		return new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(this.#deps.cwd()),
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
	}

	/** TTL-refreshed skills scan shared by skills.list and commands.list. */
	async getSkills(): Promise<SkillListItem[]> {
		if (!this.#skillsCache || Date.now() - this.#skillsCache.at > 10_000) {
			const { discoverSkills } = await import("../../sdk");
			const { skills, warnings } = await discoverSkills(this.#deps.cwd());
			const scanned = skills.map(s => ({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				source: s.source,
				hide: s.hide === true,
				_source: s._source,
			}));
			// 扩展声明的虚拟技能(registerSkill):与文件扫描技能合并展示。
			// 无 backing 文件(filePath=""),
			// content 随行携带供 skills.read 直接返回;扩展卸载/禁用后
			// 自动消失(collectExtensionSkills 按 active 过滤)。
			const { collectExtensionSkills } = await import("../extension-artifact-compiler");
			const extSkills = await collectExtensionSkills(
				(await this.#deps.extensionEntries()).map(e => ({
					kind: e.kind,
					state: e.state,
					path: e.path,
				})),
				this.#deps.cwd(),
			);
			const virtual = extSkills.map(s => ({
				name: s.name,
				description: s.description,
				filePath: "",
				source: "extension",
				hide: s.hide === true,
				content: s.content,
				_source: {
					provider: "extension",
					providerName: s.extensionPath,
					path: s.extensionPath,
					level: "user" as const,
				},
			}));
			this.#skillsCache = {
				at: Date.now(),
				skills: [...scanned, ...virtual],
				warnings: warnings.map(w => `${w.skillPath}: ${w.message}`),
			};
		}
		return this.#skillsCache.skills;
	}

	/** 宿主 watcher（#scheduleExtensionReload）技能扫描失效入口。 */
	invalidateSkillsCache(): void {
		this.#skillsCache = null;
	}

	/** RPC marketplace.list：GUI 商店面板的目录 + 安装态（10s TTL 缓存）。 */
	async list() {
		// Marketplace catalog + install state for the GUI store panel.
		// Mirrors TUI /marketplace discover output, plus an
		// installed/installedScope pair derived from the merged
		// installed-plugins registry so the card grid can flip its
		// "Install"/"Remove" affordance without a second RPC.
		// TTL-cached so flipping the marketplace tab doesn't rewalk
		// every catalog; the install/remove handlers below bust it.
		if (!this.#marketplaceCache || Date.now() - this.#marketplaceCache.at > 10_000) {
			const m = await import("../../extensibility/plugins/marketplace");
			const { getMarketplacesRegistryPath, listMarketplaceEntries, readMarketplacesRegistry } = m;
			const manager = await this.#buildMarketplaceManager();
			const registry = await readMarketplacesRegistry(getMarketplacesRegistryPath());
			const catalogs = new Map<string, Awaited<ReturnType<typeof manager.listAvailablePlugins>>>();
			for (const mkt of registry.marketplaces) {
				const plugins = await manager.listAvailablePlugins(mkt.name);
				catalogs.set(mkt.name, plugins);
			}
			const userReg = await m.readInstalledPluginsRegistry(m.getInstalledPluginsRegistryPath());
			const projectPath = await resolveOrDefaultProjectRegistryPath(this.#deps.cwd());
			const projectReg = projectPath ? await m.readInstalledPluginsRegistry(projectPath) : null;
			const entries = listMarketplaceEntries({
				registry,
				catalogs,
				userRegistry: userReg,
				projectRegistry: projectReg,
			});
			this.#marketplaceCache = { at: Date.now(), entries };
		}
		return { entries: this.#marketplaceCache.entries };
	}

	/** RPC marketplace.install：安装一个 marketplace 插件（GUI 商店 → Install）。 */
	async install(params: unknown) {
		// Install a marketplace plugin (GUI store → Install button).
		// Busts caches so the next list reflects the new state.
		const p = (params ?? {}) as { name?: string; marketplace?: string; scope?: "user" | "project" };
		if (!p.name) throw new Error("marketplace.install: name required");
		if (!p.marketplace) throw new Error("marketplace.install: marketplace required");
		const manager = await this.#buildMarketplaceManager();
		await manager.installPlugin(p.name, p.marketplace, {
			scope: p.scope ?? "user",
		});
		this.#marketplaceCache = null;
		this.#deps.invalidatePluginCaches();
		return { ok: true, installed: true, scope: p.scope ?? "user" };
	}

	/** RPC marketplace.remove：移除已装 marketplace 插件（GUI 商店 → Remove）。 */
	async remove(params: unknown) {
		// Remove an installed marketplace plugin (GUI store → Remove).
		// 拼 pluginId = "name@marketplace" 给 manager.uninstallPlugin。
		const p = (params ?? {}) as { name?: string; marketplace?: string; scope?: "user" | "project" };
		if (!p.name) throw new Error("marketplace.remove: name required");
		if (!p.marketplace) throw new Error("marketplace.remove: marketplace required");
		const { buildPluginId } = await import("../../extensibility/plugins/marketplace");
		const manager = await this.#buildMarketplaceManager();
		await manager.uninstallPlugin(buildPluginId(p.name, p.marketplace), p.scope);
		this.#marketplaceCache = null;
		this.#deps.invalidatePluginCaches();
		return { ok: true };
	}

	/** RPC skills.list：settings → skills tab 的技能清单（enablement 响应时计算）。 */
	async listSkills() {
		// Session-independent skill discovery (settings → skills tab).
		const skills = await this.getSkills();
		// Per-skill enablement is computed at response time (NOT
		// cached): skills.ignoredSkills is what the agent loop applies
		// (loadSkills glob patterns), and the toggles below write it.
		const settings = this.#deps.settings();
		const ignored = (settings?.get("skills.ignoredSkills") ?? []) as string[];
		const list = skills.map(s => ({
			...s,
			ignored: ignored.some(pattern => new Bun.Glob(pattern).match(s.name)),
		}));
		return { skills: list, warnings: this.#skillsCache!.warnings };
	}

	/** RPC skills.delete：删除 user 级文件技能的 SKILL.md（四重来源守卫）。 */
	async deleteSkill(params: unknown) {
		// Remove a user-level skill's SKILL.md. Refuses builtin /
		// musepi-managed skills (auto-learn) and extension-declared
		// virtual skills — the GUI mirrors this guard.
		const p = (params ?? {}) as { name: string };
		const skills = await this.getSkills();
		const skill = skills.find(s => s.name === p.name);
		if (!skill) throw new Error(`unknown skill: ${p.name}`);
		const src = skill._source;
		if (
			skill.filePath === "" ||
			src?.level !== "user" ||
			src.provider === MANAGED_SKILLS_PROVIDER_ID ||
			src.provider === "native" ||
			src.provider === "extension"
		) {
			throw new Error("only user-level file skills can be deleted");
		}
		const { rm } = await import("node:fs/promises");
		await rm(skill.filePath, { force: true });
		this.#skillsCache = null;
		// extensions.list 也聚合 skill 项:清扩展缓存 + 广播,让
		// GUI 单例注册表立即刷新(消费端不再本地乐观过滤)。
		this.#deps.invalidateExtensionsCache();
		this.#deps.onChanged();
		return { ok: true };
	}

	/** RPC skills.install：从 git URL 安装技能到 user 级 skills 目录。 */
	async installSkill(params: unknown) {
		// Capability-center install flow (issue follow-up: skills were
		// list/read/delete only — the user had no way to add one from the
		// GUI). Installs into the user-level skills dir; local-path sources
		// stay disabled (parseGitUrl is the fetch-and-write gate).
		const p = (params ?? {}) as { url?: string; subdir?: string; name?: string; overwrite?: boolean };
		if (!p.url) throw new Error("url is required (https git URL or owner/repo)");
		const { installSkillFromGit } = await import("../../skills/install");
		const result = await installSkillFromGit({
			url: p.url,
			subdir: p.subdir,
			name: p.name,
			overwrite: p.overwrite,
			destRoot: path.join(getAgentDir(), "skills"),
		});
		this.#skillsCache = null;
		this.#deps.invalidateExtensionsCache();
		this.#deps.onChanged();
		return { ok: true, name: result.name, dir: result.dir };
	}

	/** RPC skills.read：技能详情面板的 SKILL.md 源码（OpenCode parity）。 */
	async readSkill(params: unknown) {
		// SKILL.md source for the skill detail pane (OpenCode parity).
		const p = (params ?? {}) as { name: string };
		const skills = await this.getSkills();
		const skill = skills.find(s => s.name === p.name);
		if (!skill) throw new Error(`unknown skill: ${p.name}`);
		// 扩展声明的虚拟技能:无 backing 文件,content 随行携带。
		if (skill.filePath === "" && skill.content !== undefined) {
			const content = skill.content;
			return {
				name: skill.name,
				filePath: "",
				content: content.length > 64 * 1024 ? `${content.slice(0, 64 * 1024)}\n… (truncated)` : content,
			};
		}
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(skill.filePath, "utf8");
		return {
			name: skill.name,
			filePath: skill.filePath,
			content: content.length > 64 * 1024 ? `${content.slice(0, 64 * 1024)}\n… (truncated)` : content,
		};
	}

	/** RPC skills.marketplace.query：远程技能市场检索（SkillHub + skills.sh）。 */
	async querySkillMarket(params: unknown) {
		// Remote skill catalog (capability center → 发现). Public
		// SkillHub + skills.sh; no registry entry required, which is
		// why this is NOT routed through plugins/marketplace (that one
		// only serves user-added plugin sources and was empty).
		const p = (params ?? {}) as {
			keyword?: string;
			category?: string;
			sources?: ("skillhub" | "skills.sh")[];
			sortBy?: "downloads" | "stars" | "installs";
			pageSize?: number;
			/** 1-indexed; the grid pages with it (SkillHub rejects 0). */
			page?: number;
		};
		const { querySkillMarket } = await import("../../skills/marketplace-client");
		return await querySkillMarket({
			keyword: p.keyword,
			category: p.category,
			sources: p.sources,
			sortBy: p.sortBy,
			pageSize: p.pageSize,
			page: p.page,
		});
	}

	/** RPC skills.marketplace.categories：SkillHub 一级分类 chip 行（软失败）。 */
	async skillCategories() {
		// Chip row source (SkillHub first-level categories).
		const { listSkillHubCategories } = await import("../../skills/marketplace-client");
		try {
			return { categories: await listSkillHubCategories(), failures: [] as string[] };
		} catch (e: unknown) {
			// A dead catalog must not blank the chips: fall back to
			// empty and let the UI show the failure line.
			return {
				categories: [],
				failures: [e instanceof Error ? e.message : String(e)],
			};
		}
	}

	/** RPC skills.marketplace.featured：精选榜（design spec frame 01，软失败）。 */
	async featuredSkills(params: unknown) {
		// 精选 (design spec frame 01): the ranked top of the catalog.
		const p = (params ?? {}) as { pageSize?: number };
		const { topSkillHub } = await import("../../skills/marketplace-client");
		try {
			return { entries: await topSkillHub(p.pageSize ?? 8), failures: [] as string[] };
		} catch (e: unknown) {
			return { entries: [], failures: [e instanceof Error ? e.message : String(e)] };
		}
	}

	/** RPC skills.marketplace.detail：抽屉详情（frame 03：版本 + 文件树 + audit）。 */
	async skillDetail(params: unknown) {
		// Drawer detail (frame 03): version + file tree + audit.
		const p = (params ?? {}) as { slug?: string };
		if (!p.slug) throw new Error("skills.marketplace.detail: slug required");
		const { skillHubDetail } = await import("../../skills/marketplace-client");
		return await skillHubDetail(p.slug);
	}
}
