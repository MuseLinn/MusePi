/**
 * 六字段能力缝声明（索引：docs/capability-seams.md「应用目录 provider seam」）：
 * - 名称+ns：`ApplicationProvider`；`applicationProviders.register(provider)`，
 *   便捷入口 `registerApplicationProvider(provider)`。
 * - 输入：provider 名、`list({query?, runningOnly?})`、`open(target, {activate?})`。
 * - 输出：`desktop.apps()` / `desktop.launch()` 的结果；disposer 释放后 worker
 *   回退内置目录（Windows 原生、其它平台文件系统目录）。
 * - 生命周期：宿主插件 apply 时注册（建议包在 `ctx.effect` 里）；扩展卸载、
 *   重载或 disposer 调用时注销。
 * - 启停：同一时刻只允许一个 provider；未注册时由 worker 内置目录回答。
 * - 冲突：第二次注册拒绝并点名现任 provider；provider 释放前必须先停止接单、
 *   关闭资源并等待自有工作，注册表只保证槽位独占。
 * - 检视入口：本文件、worker 的 `#callHostProvider`、supervisor 的
 *   `#dispatchProviderCall`、`test/tools/app-provider.test.ts`。
 */
/**
 * Application catalogue capability seam.
 *
 * The computer worker runs on its own thread and owns the native desktop
 * session, so its built-in catalogue (native on Windows, the filesystem
 * catalogue elsewhere) is the default. A host may replace that source — a
 * remote catalogue, a sandbox, a deployment-specific allowlist — without
 * touching the worker or the model-facing tool.
 *
 * The seam is deliberately plain TypeScript: domain code never imports a
 * composition kernel. The cordis binding, when a deployment wants one, lives
 * in the host layer and calls {@link registerApplicationProvider}.
 *
 * Registration is exclusive and named, following the same rule as the
 * computer-use provider registry: one source answers at a time, a second
 * registration fails with the incumbent's name, and the disposer stops
 * admitting calls before it releases the slot.
 */

export interface ApplicationEntry {
	/** Absolute path (shortcut, bundle or desktop entry). */
	id: string;
	/** Human-facing name. */
	name: string;
	/** Where it launches from; equals `id` for every source we ship. */
	path: string;
	kind: "shortcut" | "bundle" | "desktop-entry" | "native";
	/** A process of this application is known to be running. */
	running?: boolean;
	pid?: number;
}

export interface ApplicationOpenResult {
	pid?: number;
	path: string;
}

/** One catalogue source. Implementations must be safe to call concurrently. */
export interface ApplicationProvider {
	/** Stable name used in registration diagnostics and the session snapshot. */
	readonly name: string;
	list(filter?: { query?: string; runningOnly?: boolean }): Promise<ApplicationEntry[]>;
	open(target: string, options?: { activate?: boolean }): Promise<ApplicationOpenResult>;
}

export class ApplicationProviderRegistry {
	#registration: { provider: ApplicationProvider; released: boolean } | null = null;

	/** Name of the active provider, including while it is being released. */
	get providerName(): string | null {
		return this.#registration?.provider.name ?? null;
	}

	/** The provider calls are routed to, or null when the worker's built-in
	 *  catalogue answers. */
	get provider(): ApplicationProvider | null {
		return this.#registration?.released === true ? null : (this.#registration?.provider ?? null);
	}

	/**
	 * Claim the single provider slot until the returned disposer runs.
	 *
	 * A provider that owns resources must stop admitting calls, close them and
	 * await outstanding work before calling the disposer; the registry only
	 * guarantees the slot is exclusive while it is held.
	 */
	register(provider: ApplicationProvider): () => void {
		const current = this.#registration;
		if (current !== null) {
			throw new Error(`application catalogue provider "${current.provider.name}" is already registered`);
		}
		const registration = { provider, released: false };
		this.#registration = registration;
		return () => {
			if (registration.released) return;
			registration.released = true;
			if (this.#registration === registration) this.#registration = null;
		};
	}
}

/** Process-wide registry the computer tool consults for each run. */
export const applicationProviders = new ApplicationProviderRegistry();

/** Convenience wrapper over {@link applicationProviders}. */
export function registerApplicationProvider(provider: ApplicationProvider): () => void {
	return applicationProviders.register(provider);
}
