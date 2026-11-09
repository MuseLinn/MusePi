/**
 * Plugin install service: the GUI's entry point to `PluginManager`.
 *
 * The plugin manager itself is a CLI-facing singleton with a blocking `install`.
 * The GUI needs the same capability as a set of RPC calls it can drive, watch,
 * and cancel, so this service owns a {@link PluginInstallMachine} and exposes it
 * as routes. It follows the skills install service's shape — a service `key`, a
 * route table, deps supplied by the host — so a person who has watched a skill
 * install knows what to expect from a plugin install.
 *
 * Why an install is asynchronous here and blocking in the CLI: the CLI caller
 * waits on a terminal, while the GUI caller is a renderer that must stay
 * responsive and must be able to abandon the run. Both go through the same
 * machine, so the outcome semantics (rollback on failure, cleanup on cancel,
 * capability report on success) are identical either way.
 *
 * The event payloads carry the same `type` discriminators the skills machine
 * uses, so one renderer subscription can follow both.
 *
 * PluginInstallService — 插件安装管理面（L2 宿主服务）。
 *
 * 能力缝声明（M2-4）：
 * - 名称/ns：`pluginInstall`；RPC 面 `plugins.install` /
 *   `plugins.install.status` / `plugins.install.cancel` / `plugins.install.output`
 *   / `plugins.uninstall`。
 * - 输入：`plugins.install` 收 `{ spec, force?, approvedBuilds? }`。spec 为包名、git 源、
 *   tarball（本地归档或 http(s) URL）或绝对路径；无法分类的 spec 在调用点即拒。
 *   其余三个 install.* 收 `{ installId }`；`plugins.uninstall` 收解析后的包名。
 * - 输出：install 立即返回 `{ installId }`；状态迁移广播
 *   `plugins.install.state`，包管理器输出逐块广播 `plugins.install.output`；
 *   status/output 可回读。完成时带能力报告（可运行/部分/不兼容）与缺失项。
 * - 生命周期：install 登记记录并异步驱动状态机；cancel 中止包管理器并等回滚
 *   落定后才回终态；stop 中止全部在途安装。完成时经 deps 失效插件缓存、广播
 *   变更，并把新入口应用到活跃会话（流式会话延迟到其空闲边界），结果广播
 *   `plugins.apply.state`（applied / pending + 计数与错误）。
 * - 启停：常驻随 daemon 启停；未注册 `pluginInstall` 服务的宿主上，
 *   `plugins.install` 报 Unknown method，与其它未装配服务同一处置。
 * - 冲突：同一 spec 的在途安装互斥（重入即拒）；与 `marketplace.install` 不做
 *   互斥——两者写同一个 plugins/package.json 的不同形态（registry 条目 vs
 *   目录链接），并发时各自回滚兜底。
 * - 检视入口：daemon 服务注册表 `pluginInstall`，RPC 路由表见本类 `routes`。
 *
 * 范围边界（有意不包）：
 * - 包管理的实际执行、回滚与 name 解析归 PluginManager 与状态机本体；
 * - 插件源发现与下载归 marketplace 面（`marketplace.*`）；
 * - 单个会话内由人发起的显式热重载仍归 ExtensionService；本服务只在包安装/
 *   卸载这一动作上向所有活跃会话投递一次。
 */

import { PluginManager } from "../../extensibility/plugins/management/manager";
import {
	PluginInstallMachine,
	type PluginInstallOutputLine,
	type PluginInstallStartParams,
	type PluginInstallView,
} from "../../extensibility/plugins/management/plugin-install-machine";
import { applyPackageChange, type LiveApplySummary, type LiveApplyTarget } from "../live-plugin-apply";
import type { DaemonService } from "./types";

/** Host capabilities this service needs. */
export interface PluginInstallServiceDeps {
	/** Broadcast a plugin install state transition to connected clients. */
	onInstallState(payload: Record<string, unknown>): void;
	/** Broadcast one line of package-manager output. */
	onInstallOutput(payload: Record<string, unknown>): void;
	/**
	 * Called after a completed install so the daemon re-reads plugin sources.
	 *
	 * An installed plugin is not live until the next session or a reload; without
	 * this the GUI would show an installed plugin that never appears.
	 */
	invalidatePluginCaches(): void;
	/** Tell connected clients the plugin set changed. */
	onChanged(): void;
	/** The working directory a project-scoped install would resolve against. */
	cwd(): string;
	/**
	 * The extension entry paths a package contributes, by resolved package name.
	 *
	 * Read before an uninstall removes the package — afterwards there is no
	 * inventory row left to resolve. Absent → no live apply (the change still
	 * lands for the next session).
	 */
	resolvePackagePaths?(name: string): Promise<string[]>;
	/** Apply a change to sessions that are already running. */
	applyLive?(target: LiveApplyTarget): Promise<LiveApplySummary>;
	/** Broadcast the live-apply outcome (`plugins.apply.state`). */
	onApplyState?(payload: Record<string, unknown>): void;
}

export class PluginInstallService implements DaemonService {
	readonly key = "pluginInstall";
	readonly routes = {
		"plugins.install": "install",
		"plugins.install.status": "installStatus",
		"plugins.install.cancel": "cancelInstall",
		"plugins.install.output": "installOutput",
		"plugins.uninstall": "uninstall",
	} as const;

	readonly #deps: PluginInstallServiceDeps;
	readonly #manager: PluginManager;
	readonly #installs: PluginInstallMachine;

	constructor(deps: PluginInstallServiceDeps) {
		this.#deps = deps;
		this.#manager = new PluginManager();
		this.#installs = new PluginInstallMachine(
			this.#manager,
			view => {
				if (view.state === "done") {
					// A new plugin is not live until the daemon re-reads plugin sources;
					// without these two calls the GUI shows a plugin that never loads.
					this.#deps.invalidatePluginCaches();
					this.#deps.onChanged();
					// Sessions that are already open can take the new code now; a
					// streaming one parks it and reports `pending`.
					void this.#applyLive("install", view.name);
				}
				// The envelope's `at` is stamped last so it records the moment the
				// event went out, not a field the view happens to carry.
				deps.onInstallState({ ...view, type: "plugins.install.state", at: Date.now() });
			},
			line => deps.onInstallOutput({ ...line, type: "plugins.install.output", at: Date.now() }),
		);
	}

	/**
	 * Begin an install.
	 *
	 * @param params - `{ spec, force?, approvedBuilds? }`. The spec is a package name, a git
	 * source, a tarball, or an absolute path.
	 * @returns the install id to poll, read output for, or cancel.
	 * @throws {InvalidInstallSpecError} when the spec cannot be classified, so a
	 * malformed spec is refused at the call rather than becoming a failed run.
	 */
	install(params: PluginInstallStartParams): { installId: string } {
		return { installId: this.#installs.start(params) };
	}

	/** The status view: live installs first, then terminal records newest-first. */
	installStatus(): { installs: PluginInstallView[] } {
		return this.#installs.status();
	}

	/**
	 * Ask a live install to stop.
	 *
	 * @param params - `{ installId }`.
	 * @returns `cancelled` when accepted, `not-running` for an unknown or
	 * already-finished install.
	 */
	cancelInstall(params: { installId: string }): { status: "cancelled" | "not-running" } {
		return this.#installs.cancel(params.installId);
	}

	/** The retained output transcript for one install. */
	installOutput(params: { installId: string }): { lines: PluginInstallOutputLine[] } {
		return { lines: this.#installs.output(params.installId) };
	}

	/**
	 * Uninstall a plugin by its resolved package name.
	 *
	 * This is blocking and reports through the RPC result rather than through the
	 * install machine: a removal has no state worth watching, it either completes
	 * or leaves the same rollback the install path already guarantees.
	 */
	async uninstall(params: {
		name: string;
	}): Promise<{ name: string; application?: "applied" | "pending"; applied?: number; deferred?: number }> {
		// The package row is what resolves its entry paths, so read them before
		// the removal makes the inventory forget the package.
		const paths = await this.#deps.resolvePackagePaths?.(params.name);
		await this.#manager.uninstall(params.name);
		this.#deps.invalidatePluginCaches();
		this.#deps.onChanged();
		const summary = await this.#applyLive("uninstall", params.name, paths);
		return {
			name: params.name,
			...(summary !== undefined
				? {
						application: summary.deferred > 0 ? "pending" : "applied",
						applied: summary.applied,
						deferred: summary.deferred,
					}
				: {}),
		};
	}

	/**
	 * Detach a package's entries from running sessions and tell the GUI what
	 * actually happened.
	 *
	 * `application` is the same distinction the rest of the host makes: entries
	 * that were idle swapped immediately (`applied`); entries in a streaming
	 * session are parked for that session's next idle boundary (`pending`). A
	 * failed entry is still reported as an error even when other sessions
	 * applied, so the caller never reads a partial success as complete.
	 */
	#applyLive(
		change: "install" | "uninstall",
		packageName: string | undefined,
		knownPaths?: string[],
	): Promise<LiveApplySummary | undefined> {
		return applyPackageChange(this.#deps, change, packageName, knownPaths);
	}

	/**
	 * Abort every live install and wait for the rollbacks to land.
	 *
	 * Reached through the cordis disposer (the host mounts this service with
	 * `lifecycle: "cordis"`), so it runs on daemon shutdown and on a future hot
	 * reload. It awaits the machine's own stop rather than firing and returning:
	 * an aborted install restores the plugins directory, and a shutdown that
	 * returned mid-restore would leave that directory holding a half-written
	 * state.
	 */
	stop(): Promise<void> {
		return this.#installs.stop();
	}
}
