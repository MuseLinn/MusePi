import { getOrCreateClient, notifySaved, sendRequest, syncContent } from "../../lsp/client";
import { waitForDiagnostics } from "../../lsp/diagnostics";
import { getConfig, getLspServerForFile } from "../../lsp/servers";
import type { Diagnostic, LspClient } from "../../lsp/types";
import { fileToUri } from "../../lsp/utils";
import type { DaemonService } from "./types";

/**
 * EditorService — Monaco 文件编辑器的语言智能面（L2 宿主服务）。
 *
 * 能力缝声明：
 * - 名称/命名空间：`editor`；RPC `editor.sync` / `editor.saved` /
 *   `editor.hover` / `editor.completion` / `editor.definition` / `editor.implementation` /
 *   `editor.typeDefinition` / `editor.references` / `editor.rename`，诊断随 sync 返回。
 * - 输入：工作区 cwd、文件路径、内存文本；位置类请求使用 LSP 0 基行列；
 *   references 另收 includeDeclaration，rename 另收非空 newName。
 * - 输出：`{ available, diagnostics?/result? }` 软结果；无匹配服务器、初始化失败、
 *   请求取消或超时均安静降级，不向 GUI 抛错误。rename 原样返回 WorkspaceEdit。
 * - 生命周期：服务无自有进程或文档状态；按需复用 `lsp/client.ts` 的进程级客户端、
 *   文档版本、写锁和既有 idleTimeout。保存通知由 FilePane 在落盘成功后发起。
 * - 启停：RPC 服务随 daemon 注册；语言服务器仅在编辑对应文件时启动，服务器禁用或
 *   无匹配时不执行同步。共享客户端由既有 LSP 配置和 idle 策略停止。
 * - 冲突：与 agent LSP 工具共用同一客户端，不启动第二套服务器；不支持 snippet、
 *   code action 或文件资源写操作。检视入口为路由表及既有 `getLspStatus()`。
 */

export interface EditorDocumentParams {
	cwd?: string;
	path?: string;
	content?: string;
}

export interface EditorPositionParams extends EditorDocumentParams {
	line?: number;
	character?: number;
}

export interface EditorReferenceParams extends EditorPositionParams {
	includeDeclaration?: boolean;
}

export interface EditorRenameParams extends EditorPositionParams {
	newName?: string;
}

export interface EditorServiceDeps {
	resolveClient(cwd: string, filePath: string, signal: AbortSignal): Promise<LspClient | null>;
	sync(client: LspClient, filePath: string, content: string, signal: AbortSignal): Promise<void>;
	saved(client: LspClient, filePath: string, signal: AbortSignal): Promise<void>;
	diagnostics(client: LspClient, filePath: string, signal: AbortSignal): Promise<Diagnostic[]>;
	request(client: LspClient, method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
}

const defaultDeps: EditorServiceDeps = {
	resolveClient: async (cwd, filePath, signal) => {
		const selected = getLspServerForFile(getConfig(cwd), filePath);
		return selected ? await getOrCreateClient(selected[1], cwd, undefined, signal) : null;
	},
	sync: syncContent,
	saved: notifySaved,
	diagnostics: (client, filePath, signal) =>
		waitForDiagnostics(client, fileToUri(filePath), { signal, timeoutMs: 1_200, settleMs: 100 }),
	request: (client, method, params, signal) => sendRequest(client, method, params, signal),
};

export class EditorService implements DaemonService {
	readonly key = "editor";
	readonly routes = {
		"editor.completion": "completion",
		"editor.definition": "definition",
		"editor.hover": "hover",
		"editor.implementation": "implementation",
		"editor.typeDefinition": "typeDefinition",
		"editor.references": "references",
		"editor.rename": "rename",
		"editor.saved": "saved",
		"editor.sync": "sync",
	} as const;

	readonly #deps: EditorServiceDeps;

	constructor(deps: EditorServiceDeps = defaultDeps) {
		this.#deps = deps;
	}

	async sync(params: EditorDocumentParams): Promise<{ available: boolean; diagnostics: Diagnostic[] }> {
		const signal = AbortSignal.timeout(10_000);
		const document = this.#document(params);
		if (!document) return { available: false, diagnostics: [] };
		try {
			const client = await this.#deps.resolveClient(document.cwd, document.path, signal);
			if (!client) return { available: false, diagnostics: [] };
			await this.#deps.sync(client, document.path, document.content, signal);
			const diagnostics = await this.#deps.diagnostics(client, document.path, signal);
			return { available: true, diagnostics };
		} catch {
			return { available: false, diagnostics: [] };
		}
	}

	async saved(params: EditorDocumentParams): Promise<{ available: boolean }> {
		const signal = AbortSignal.timeout(10_000);
		const document = this.#document(params);
		if (!document) return { available: false };
		try {
			const client = await this.#deps.resolveClient(document.cwd, document.path, signal);
			if (!client) return { available: false };
			await this.#deps.sync(client, document.path, document.content, signal);
			await this.#deps.saved(client, document.path, signal);
			return { available: true };
		} catch {
			return { available: false };
		}
	}

	async hover(params: EditorPositionParams): Promise<{ available: boolean; result: unknown | null }> {
		return this.#positionRequest("textDocument/hover", params);
	}

	async completion(params: EditorPositionParams): Promise<{ available: boolean; result: unknown | null }> {
		return this.#positionRequest("textDocument/completion", params);
	}

	async definition(params: EditorPositionParams): Promise<{ available: boolean; result: unknown | null }> {
		return this.#positionRequest("textDocument/definition", params);
	}

	async implementation(params: EditorPositionParams): Promise<{ available: boolean; result: unknown | null }> {
		return this.#positionRequest("textDocument/implementation", params);
	}

	async typeDefinition(params: EditorPositionParams): Promise<{ available: boolean; result: unknown | null }> {
		return this.#positionRequest("textDocument/typeDefinition", params);
	}

	async references(params: EditorReferenceParams): Promise<{ available: boolean; result: unknown | null }> {
		return this.#positionRequest("textDocument/references", params, {
			context: { includeDeclaration: params.includeDeclaration === true },
		});
	}

	async rename(params: EditorRenameParams): Promise<{ available: boolean; result: unknown | null }> {
		if (typeof params.newName !== "string" || params.newName.trim() === "") {
			return { available: false, result: null };
		}
		return this.#positionRequest("textDocument/rename", params, { newName: params.newName });
	}

	async #positionRequest(
		method: string,
		params: EditorPositionParams,
		additional?: Record<string, unknown>,
	): Promise<{ available: boolean; result: unknown | null }> {
		const signal = AbortSignal.timeout(10_000);
		const document = this.#document(params);
		const { line, character } = params;
		if (
			!document ||
			typeof line !== "number" ||
			!Number.isInteger(line) ||
			typeof character !== "number" ||
			!Number.isInteger(character)
		) {
			return { available: false, result: null };
		}
		try {
			const client = await this.#deps.resolveClient(document.cwd, document.path, signal);
			if (!client) return { available: false, result: null };
			await this.#deps.sync(client, document.path, document.content, signal);
			const result = await this.#deps.request(
				client,
				method,
				{
					textDocument: { uri: fileToUri(document.path) },
					position: { line, character },
					...additional,
				},
				signal,
			);
			return { available: true, result };
		} catch {
			return { available: false, result: null };
		}
	}

	#document(params: EditorDocumentParams): { cwd: string; path: string; content: string } | null {
		if (!params?.cwd || !params.path || typeof params.content !== "string") return null;
		return { cwd: params.cwd, path: params.path, content: params.content };
	}
}
