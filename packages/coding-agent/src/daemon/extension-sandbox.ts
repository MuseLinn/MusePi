/**
 * P2 动态自举沙箱:node:vm 受限 realm 承载动态扩展的 host 半体。
 *
 * DSH cordis-host-runner sandbox.ts 的 musepi 落地(Bun 运行时):
 * - precheckCode:define 时语法预检,不运行 —— 坏代码在注册前被拒。
 * - createSandbox:新 realm,只注入白名单宿主闭包(defineTool/timers/log),
 *   process/require/Bun/globalThis 天然不在 vm context(验证过 ReferenceError)。
 * - evaluateHostCode:把 host 代码作为 async function 体执行,返回值跨 realm
 *   可 await(Bun vm 的 async 返回值是普通对象但 await 链路有效)。
 * - 超时:vm timeout 只拦截同步死循环;async 悬挂用宿主 Promise.race 竞速。
 *
 * 沙箱内函数(vm 函数对象)可在宿主调用,参数/返回值是普通值(JSON 形状),
 * 因此动态工具 handler 注册进会话工具链是安全的。
 */

import { type Context, createContext, runInContext, Script } from "node:vm";

/** 单个动态工具定义:参数声明 + 沙箱内实现的 run 处理器。 */
export interface SandboxToolDefinition {
	name: string;
	description?: string;
	/** 参数声明 {key: "string"|"number"|"boolean"} —— 映射为 omptype schema。 */
	parameters?: Record<string, "string" | "number" | "boolean">;
	/** 处理器:在沙箱 realm 定义,宿主调用。返回 string(工具文本结果)。 */
	run: (params: Record<string, unknown>) => Promise<string> | string;
}

/** 沙箱宿主 API 白名单(闭包捕获,不依赖 vm context 属性回流)。 */
export interface SandboxHostApi {
	defineTool(definition: SandboxToolDefinition): void;
	log(...args: unknown[]): void;
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * 语法预检:编译不运行。SyntaxError 的 name 是 realm 安全的判定键
 * (DSH isSyntaxError 同款 —— vm 构造的错误 instanceof 宿主 SyntaxError 为假)。
 */
export function precheckCode(code: string, what: string): void {
	try {
		new Script(code);
	} catch (error) {
		// vm 构造的错误 instanceof 宿主 SyntaxError 为假 —— name 属性是
		// realm 安全的判定键(DSH isSyntaxError 同款)。
		const name =
			typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
				? error.name
				: "";
		if (name === "SyntaxError") {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`${what} 语法错误: ${detail}`);
		}
		throw error;
	}
}

/** 构造受限 realm;hostApi 白名单闭包注入。 */
export function createSandbox(id: string, hostApi: SandboxHostApi): Context {
	const sandbox: Record<string, unknown> = {
		defineTool: hostApi.defineTool,
		setTimeout: hostApi.setTimeout,
		clearTimeout: hostApi.clearTimeout,
		console: {
			log: (...args: unknown[]) => hostApi.log(...args),
			info: (...args: unknown[]) => hostApi.log(...args),
			warn: (...args: unknown[]) => hostApi.log("[warn]", ...args),
			error: (...args: unknown[]) => hostApi.log("[error]", ...args),
			debug: (...args: unknown[]) => hostApi.log("[debug]", ...args),
		},
		// 动态插件标识:代码内可自省。
		pluginId: id,
	};
	return createContext(sandbox);
}

/** host 半体代码 → async 函数体,沙箱内定义,宿主 await 结果。 */
export async function evaluateHostCode<T>(sandbox: Context, code: string, id: string, vmTimeoutMs: number): Promise<T> {
	const fn = runInContext(`(async () => {\n${code}\n})`, sandbox, { filename: `dynamic-extension:${id}` });
	const result = fn();
	// async 悬挂保护:同步死循环由 vm timeout 侧拦截,这里只竞速悬挂。
	return await Promise.race([
		Promise.resolve(result) as Promise<T>,
		new Promise<never>((_, reject) => {
			const handle = hostSetTimeout(
				() => reject(new Error(`dynamic extension "${id}" timed out after ${vmTimeoutMs}ms`)),
				vmTimeoutMs,
			);
			// 竞速完成后清理定时器,避免悬挂的 vm promise 在超时后继续占用。
			Promise.resolve(result)
				.finally(() => hostClearTimeout(handle))
				.catch(() => undefined);
		}),
	]);
}

const hostSetTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
const hostClearTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);
