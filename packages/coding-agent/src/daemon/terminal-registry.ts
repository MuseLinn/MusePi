// ============================================================
// Terminal backend registry — cordis 收编第三刀（设计稿 §2：
// registerBackend 注册表 + provider 插件化。形状对齐
// registerBackend /
// DUPLICATE_BACKEND，不拷外部代码）。
//
// 能力缝声明（M2-2.4）：
// - 输入：TerminalBackend 注册（bun-pty / node-pty 具体实现，
//   未来 provider 插件经 registerBackend 挂入/拔出）。
// - 输出：按类型解析 backend（getBackend，未注册 = 结构化
//   NO_BACKEND 错误，调用方本地化渲染，不散装 Error.message）；
//   注册表清单（listBackends/hasBackend）供管理面与 auto 解析消费。
// - 生命周期：注册返回 Disposable（dispose = 反注册，只在该注册
//   仍是当前持有者时生效——被顶替的旧注册 dispose 不误删新 backend）；
//   进程退出随 daemon 消亡，pty 句柄清理仍在 terminal.close 路径。
// - 冲突：同类型重复注册 = DUPLICATE_BACKEND 结构化错误
//   不允许覆盖式静默顶替。
// ============================================================

/** 终端 backend 类型（显式 provider 选择的取值域）。 */
export type TerminalBackendType = "bun-pty" | "node-pty";

/** 一个打开终端会话的句柄（provider 实现返回，形状与原
 *  terminal-provider.ts 的 TerminalHandle 逐字段一致）。 */
export interface TerminalHandle {
	/** Send input (data / resize / close). */
	write(data: string): void;
	/** Resize cols/rows. */
	resize(cols: number, rows: number): void;
	/** Kill the process and clean up. */
	dispose(): void;
	/** Exit code (once emitted). */
	onExit: (cb: (code: number | null) => void) => void;
	/** Raw data received. */
	onData: (cb: (data: string) => void) => void;
}

/** 终端 backend 契约：spawn 一个 pty 会话。 */
export interface TerminalBackend {
	open(
		cwd: string,
		cols: number,
		rows: number,
		shell: string,
		shellArgs: string[],
		env: Record<string, string>,
	): Promise<TerminalHandle>;
}

/** 结构化终端错误码（只保留我方真实失败模式；
 *  不预支 FOREIGN_SESSION / OWNER_NOT_LIVE 等 owner 鉴权码，那属于
 *  terminal-core 插件化的下一刀）。DISABLED_BACKEND = 用户经插件组件
 *  开关显式禁用该后端（terminal.disabledBackends 名单命中）。 */
export type TerminalRegistryErrorCode = "DUPLICATE_BACKEND" | "NO_BACKEND" | "DISABLED_BACKEND";

/** 结构化终端错误：code 供调用方归因本地化，message 仅作日志。 */
export class TerminalRegistryError extends Error {
	readonly code: TerminalRegistryErrorCode;

	constructor(code: TerminalRegistryErrorCode, message: string) {
		super(message);
		this.name = "TerminalRegistryError";
		this.code = code;
	}
}

/**
 * Owner-scoped 终端 backend 注册表（
 * registerBackend 形状）。provider 插件化的挂点：插件装载时
 * registerBackend，卸载时 dispose 反注册——backend 缺席时
 * getBackend 给结构化 NO_BACKEND，auto 解析跳过缺席者，
 * 禁用兜底（设计稿 §3.③）由此获得真实数据源。
 */
export class TerminalRegistry {
	readonly #backends = new Map<TerminalBackendType, TerminalBackend>();

	/** 注册一个 backend；同类型已注册 = DUPLICATE_BACKEND 结构化错误
	 *  （不允许覆盖式静默顶替）。返回反注册句柄。 */
	registerBackend(type: TerminalBackendType, backend: TerminalBackend): () => void {
		if (this.#backends.has(type)) {
			throw new TerminalRegistryError("DUPLICATE_BACKEND", `terminal backend already registered: ${type}`);
		}
		this.#backends.set(type, backend);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			// 只在该注册仍是当前持有者时移除——dispose 旧注册
			// 不得误删顶替者（反注册与重挂交错的安全语义）。
			if (this.#backends.get(type) === backend) this.#backends.delete(type);
		};
	}

	/** 按类型解析 backend；未注册 = NO_BACKEND 结构化错误
	 *  （「终端后端已停用，原因：插件被禁用」归因的数据源）。 */
	getBackend(type: TerminalBackendType): TerminalBackend {
		const backend = this.#backends.get(type);
		if (!backend) {
			throw new TerminalRegistryError("NO_BACKEND", `terminal backend not registered: ${type}`);
		}
		return backend;
	}

	/** backend 是否在册（auto 解析跳过缺席者的判定）。 */
	hasBackend(type: TerminalBackendType): boolean {
		return this.#backends.has(type);
	}

	/** 在册 backend 类型清单（管理面检视）。 */
	listBackends(): TerminalBackendType[] {
		return [...this.#backends.keys()];
	}
}

/** 宿主共享注册表：server.ts 把 builtin 后端（bun-pty/node-pty）
 *  注册进来并 provide 到 cordis 根 Context（terminal:backends 键）；
 *  未来 provider 插件可以把自己的注册表实例经同一管线挂入。 */
export const defaultTerminalRegistry = new TerminalRegistry();
