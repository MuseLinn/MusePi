import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime } from "../../extensibility/extensions/loader";
import { BlobStore } from "../../session/blob-store";
import { ViewStore } from "../view-store";
import { AgentsService } from "./agents-service";
import { ApprovalService } from "./approval-service";
import { ArchiveService } from "./archive-service";
import { AttachmentService } from "./attachment-service";
import { BoardService } from "./board-service";
import { BrowserService } from "./browser-service";
import { BundleService } from "./bundle-service";
import { ConnectorCatalogService } from "./connector-catalog-service";
import { ConnectorService } from "./connector-service";
import { CreationService } from "./creation-service";
import { CredentialService } from "./credential-service";
import { DesignSystemsService } from "./design-systems-service";
import { EditorService } from "./editor-service";
import { EventService } from "./event-service";
import { ExtensionService } from "./extension-service";
import { FileService } from "./file-service";
import { GitContextService } from "./git-context-service";
import { GitService } from "./git-service";
import { GitWatchService } from "./git-watch-service";
import { GitHubService } from "./github-service";
import { KnowledgeService } from "./knowledge-service";
import { LEGACY_ROUTES } from "./legacy-routes";
import { LivenessService } from "./liveness-service";
import { MarketplaceService } from "./marketplace-service";
import { McpOAuthService } from "./mcp-oauth-service";
import { McpServersService } from "./mcp-servers-service";
import { ModelsService } from "./models-service";
import { PluginInstallService } from "./plugin-install-service";
import { PresetsService } from "./presets-service";
import { ProvidersService } from "./providers-service";
import { HostServices } from "./registry";
import { RemoteService } from "./remote-service";
import { ScheduleService } from "./schedule-service";
import { SessionPresenceService } from "./session-presence-service";
import { SessionService } from "./session-service";
import { SettingsService } from "./settings-service";
import { TerminalService } from "./terminal-service";
import { UsageService } from "./usage-service";
import { ViewStoreService } from "./view-store-service";
import { VoiceService } from "./voice-service";
import { WorkspaceRegistry, WorkspaceService } from "./workspace-registry";

/** 路由覆盖快照（P1 服务抽取纪律）：server.ts 巨型 switch 的每个 case
 *  必须二选一——委托给 HostServices 某服务，或登记在 LEGACY_ROUTES。
 *  新增 RPC 两处都不落 → 本测试失败。清单只减不增是 P1 的进度表。 */

/** session tree 客户端契约载体路由（撤回/分支/leaf 移动/快照恢复/gap fill，
 *  小袁总 2026-09-25 纪律：会话相关改动必须核对这些接口）。钉桩语义：这些
 *  路由必须永久存在于 switch 全集里——谁删了它们，测试炸谁。 */
const SESSION_TREE_ROUTES = [
	"session.branchAt",
	"session.btwBranch",
	"session.catchup",
	"session.forkAt",
	"session.regenerateAt",
	"session.resume",
	"session.tree",
] as const;

function switchCases(): string[] {
	const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
	const cases = new Set<string>();
	const pattern = /case "([a-zA-Z][a-zA-Z0-9._-]*)":/g;
	for (const match of source.matchAll(pattern)) {
		cases.add(match[1]);
	}
	return [...cases].sort();
}

function buildRegistry(): HostServices {
	const services = new HostServices();
	services.register(
		new UsageService({
			get: () => undefined,
			ensureRegistry: async () => null,
		}),
	);
	services.register(
		new EventService({
			emitEvent: () => {},
			catchupFrom: async () => ({}),
		}),
	);
	// LivenessService：无依赖，ping/system.ping 共用同一应答。
	services.register(new LivenessService());
	// ViewStore 只认领路由（本测试不触库），但构造真实实例成本极低，
	// 用临时目录避免碰默认 journal 目录。
	const store = new ViewStore(join(mkdtempSync(join(tmpdir(), "musepi-views-")), "views.db"));
	services.register(new ViewStoreService(store));
	services.register(new BoardService());
	// CreationService 只认领路由（本测试不触盘），session 头查找 stub 掉。
	services.register(new CreationService({ loadHeader: () => null }));
	// DesignSystemsService 只认领路由（design.systems.list），stub 掉宿主运行时加载。
	services.register(
		new DesignSystemsService({
			extensionRuntimeLoad: async () => ({ extensions: [], errors: [], runtime: new ExtensionRuntime() }),
		}),
	);
	services.register(
		new FileService({
			fallbackCwd: () => undefined,
			ensureFileIndex: () => ({ search: () => [] }) as never,
		}),
	);
	// GitWatchService: routes only (no roots watched in this test).
	services.register(new GitWatchService({ broadcast: () => {} }));
	// GitContextService: stateless read-only snapshot; only its route is claimed here.
	services.register(new GitContextService({ cwd: () => tmpdir() }));
	// AttachmentService：只认领路由（本测试不存取附件），blob 目录用隔离 temp。
	services.register(
		new AttachmentService({
			store: new BlobStore(join(mkdtempSync(join(tmpdir(), "musepi-blobs-")), "blobs")),
		}),
	);
	services.register(new EditorService());
	services.register(
		new TerminalService({
			nextSeq: () => 0,
			emit: () => {},
			settings: async () => null,
		}),
	);
	// ApprovalService 只认领路由（本测试不应答任何审批），stub 掉会话访问。
	services.register(new ApprovalService({ get: () => undefined }));
	// BrowserService 只认领路由（本测试不触发浏览器/CDP），stub 掉设置与 cwd。
	services.register(
		new BrowserService({
			settings: async () => {
				throw new Error("not used in coverage test");
			},
			cwd: () => ".",
		}),
	);
	// RemoteService 无宿主依赖、无状态，直接注册。
	services.register(new RemoteService());
	// ScheduleService：stub 化宿主访问，仅参与路由表。
	services.register(
		new ScheduleService({
			createSession: async () => ({ sessionId: "" }),
			get: () => undefined,
			deleteSession: async () => {},
			onCronsChanged: () => {},
		}),
	);
	// SessionService：只认领路由（本测试不触会话），stub 掉宿主访问。
	services.register(
		new SessionService({
			knownSessions: async () => [],
			getSession: () => undefined,
			snapshot: async () => ({}),
			checkpointSeq: async () => 0,
			setResumeLive: () => {},
			resolveLive: () => undefined,
			cronSessionIds: () => new Set(),
			firstUserMessage: () => "",
		}),
	);
	// AgentsService：宿主会话访问桩化，仅参与路由表。
	services.register(new AgentsService({ get: () => undefined, knownSessions: async () => [] }));
	// GitService：cwd 与 watch 桩化（本测试不跑任何 git 命令）。
	services.register(new GitService({ cwd: () => "" }));
	// GitHubService：只认领路由（本测试不调用 gh），cwd 桩化。
	services.register(new GitHubService({ cwd: () => "" }));
	// KnowledgeService：只认领路由（本测试不读写笔记/计划/待办），cwd 桩化。
	services.register(new KnowledgeService({ cwd: () => "" }));
	// PresetsService：预设目录与扩展面桩化（本测试不读写预设文件）。
	services.register(
		new PresetsService({
			cwd: () => "",
			get: () => undefined,
			persistHeaderPatch: () => false,
			modesDir: () => "",
			knownExtensions: async () => [],
			broadcastModesChanged: () => {},
		}),
	);
	// ModelsService：只认领路由（本测试不读写 models.yml），宿主访问桩化。
	services.register(
		new ModelsService({
			get: () => undefined,
			ensureRegistry: async () => null,
			broadcastModelsChanged: () => {},
		}),
	);
	// ProvidersService：登录流程桩化（本测试不发起 OAuth），只认领路由。
	services.register(
		new ProvidersService({
			ensureRegistry: async () => null,
			emitEvent: () => {},
			nextEventSeq: () => 0,
			broadcastModelsChanged: () => {},
		}),
	);
	// SettingsService：宿主设置面桩化（本测试只校验路由归属）。
	services.register(
		new SettingsService({
			cwd: () => "",
			ensureRegistry: async () => null,
			extensionSettings: () => null,
			settings: () => null,
		} as never),
	);
	// SessionPresenceService：只认领 session.presence，宿主访问桩化。
	services.register(new SessionPresenceService({ get: () => undefined, knownSessions: async () => [] }));
	// VoiceService：只认领路由（本测试不触发语音引擎），广播桩吞掉分片事件。
	services.register(new VoiceService({ broadcast: () => {} }));
	// ExtensionService：stub 化宿主访问，仅参与路由表。
	services.register(
		new ExtensionService({
			settings: () => null,
			ensureRegistry: async () => {},
			cwd: () => "",
			webUrl: () => null,
			webPortFile: () => "",
			onChanged: () => {},
		}),
	);
	// MarketplaceService：stub 化宿主访问，仅参与路由表。
	services.register(
		new MarketplaceService({
			cwd: () => "",
			settings: () => null,
			extensionEntries: async () => [],
			invalidateExtensionsCache: () => {},
			invalidatePluginCaches: () => {},
			onChanged: () => {},
			onInstallState: () => {},
		}),
	);
	// ConnectorService：只认领路由（本测试不触会话），stub 掉宿主访问。
	services.register(
		new ConnectorService({
			connectorsSnapshot: () => null,
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			readSelection: () => null,
			setSelection: async () => ({ ok: true, appliedToLive: false }),
		}),
	);
	// McpServersService：只认领路由（本测试不读写 mcp.json），路径用隔离 temp。
	services.register(
		new McpServersService({
			userConfigPath: () => join(mkdtempSync(join(tmpdir(), "musepi-mcp-")), "mcp.json"),
		}),
	);
	// McpOAuthService：只认领路由（本测试不发起登录），宿主访问全部 stub。
	services.register(
		new McpOAuthService({
			cwd: () => "",
			authStorage: async () => null,
		}),
	);
	// ConnectorCatalogService：只认领路由（本测试不读目录），stub 掉宿主访问。
	services.register(
		new ConnectorCatalogService({
			cwd: () => "",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
		}),
	);
	// CredentialService：凭据 store 指向隔离 temp 文件（本测试不触凭据面）。
	services.register(
		new CredentialService({
			storePath: join(mkdtempSync(join(tmpdir(), "musepi-creds-")), "credentials.json"),
		}),
	);
	// PluginInstallService：只认领路由（本测试不发起安装），stub 掉宿主访问。
	services.register(
		new PluginInstallService({
			cwd: () => "",
			invalidatePluginCaches: () => {},
			onChanged: () => {},
			onInstallState: () => {},
			onInstallOutput: () => {},
		}),
	);
	// BundleService：只认领路由（本测试不读盘组合），stub 掉宿主访问。
	services.register(
		new BundleService({
			cwd: () => "",
			home: () => "",
			invalidate: () => {},
		}),
	);
	// ArchiveService：无宿主依赖（本测试不发起归档），仅需认领路由参与闭包。
	services.register(new ArchiveService({ archivesDir: () => join(mkdtempSync(join(tmpdir(), "musepi-arch-")), "z") }));
	// WorkspaceService：注册表文件指向隔离 temp，仅认领路由（本测试不触会话）。
	services.register(
		new WorkspaceService({
			registry: new WorkspaceRegistry({
				filePath: join(mkdtempSync(join(tmpdir(), "musepi-projects-")), "projects.json"),
			}),
			knownSessionCwds: async () => [],
			sessionDirectories: () => undefined,
		}),
	);
	return services;
}

describe("P1 route coverage", () => {
	it("every switch case is claimed by a service or the legacy manifest", () => {
		const table = buildRegistry().routeTable();
		const legacy = new Set(LEGACY_ROUTES);
		const uncovered = switchCases().filter(route => !table.has(route) && !legacy.has(route));
		expect(uncovered).toEqual([]);
	});

	it("delegated routes and legacy manifest are disjoint", () => {
		const table = buildRegistry().routeTable();
		const overlap = LEGACY_ROUTES.filter(route => table.has(route));
		expect(overlap).toEqual([]);
	});

	it("legacy manifest has no duplicate entries", () => {
		expect(new Set(LEGACY_ROUTES).size).toBe(LEGACY_ROUTES.length);
	});

	it("service routeTable rejects duplicate route claims across services", () => {
		const services = new HostServices();
		services.register(
			new UsageService({
				get: () => undefined,
				ensureRegistry: async () => null,
			}),
		);
		const clash = new UsageService({
			get: () => undefined,
			ensureRegistry: async () => null,
		});
		// Same key can't be registered twice either.
		expect(() => services.register(clash)).toThrow(/duplicate service key/);
	});

	it("every service route has a switch case (防「Unknown method」反向门禁)", () => {
		// 正向门禁（第一个测试）只查 switch ⊆ 路由表；2026-09-30 组件开关 GUI 报
		// 「Unknown method: extensions.setComponentEnabled」的根因正是 routes 表
		// 有登记、switch 漏挂 case。反向必须同样钉死：服务认领的每条路由都要能被
		// 客户端真实调到。
		const table = buildRegistry().routeTable();
		const cases = new Set(switchCases());
		const missing = [...table.keys()].filter(route => !cases.has(route)).sort();
		expect(missing).toEqual([]);
	});

	it("session tree contract routes are pinned in the switch (客户端 tree 接口不许静默消失)", () => {
		const cases = new Set(switchCases());
		const missing = SESSION_TREE_ROUTES.filter(route => !cases.has(route));
		expect(missing).toEqual([]);
	});

	it("remote-access RPC aliases stay routable alongside legacy collab clients", () => {
		const cases = new Set(switchCases());
		for (const action of ["start", "status", "stop", "pair.generate"]) {
			expect(cases.has(`remote-access.${action}`)).toBe(true);
			expect(cases.has(`collab.${action}`)).toBe(true);
		}
	});
});
