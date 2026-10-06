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
 * - 输入：`plugins.install` 收 `{ spec, force? }`。spec 为包名、git 源、
 *   tarball（本地归档或 http(s) URL）或绝对路径；无法分类的 spec 在调用点即拒。
 *   其余三个 install.* 收 `{ installId }`；`plugins.uninstall` 收解析后的包名。
 * - 输出：install 立即返回 `{ installId }`；状态迁移广播
 *   `plugins.install.state`，包管理器输出逐块广播 `plugins.install.output`；
 *   status/output 可回读。完成时带能力报告（可运行/部分/不兼容）与缺失项。
 * - 生命周期：install 登记记录并异步驱动状态机；cancel 中止包管理器并等回滚
 *   落定后才回终态；stop 中止全部在途安装。完成时经 deps 失效插件缓存并广播变更。
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
 * - 会话内插件热重载归 ExtensionService，本服务完成后只发失效通知。
 */

import { PluginManager } from "../../extensibility/plugins/manager";
import {
	PluginInstallMachine,
	type PluginInstallOutputLine,
	type PluginInstallStartParams,
	type PluginInstallView,
} from "../../extensibility/plugins/plugin-install-machine";
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
	 * @param params - `{ spec, force? }`. The spec is a package name, a git
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
	async uninstall(params: { name: string }): Promise<{ name: string }> {
		await this.#manager.uninstall(params.name);
		this.#deps.invalidatePluginCaches();
		this.#deps.onChanged();
		return { name: params.name };
	}

	/** Abort every live install when the daemon stops. */
	stop(): void {
		for (const view of this.#installs.status().installs) {
			if (view.state === "inspecting" || view.state === "installing") {
				this.#installs.cancel(view.installId);
			}
		}
	}
}
