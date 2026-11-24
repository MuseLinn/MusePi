import * as path from "node:path";
import type {
	SecretAnswerParams,
	SecretAnswerResult,
	SecretDeleteParams,
	SecretDeleteResult,
	SecretListResult,
	SecretScope,
	SecretScopeChoice,
	SecretSetParams,
	SecretSetResult,
	SecretStatus,
	SecretUpdateParams,
	SecretUpdateResult,
} from "@musepi/pi-wire";
import { notifyAgentSecretSaved } from "../../secrets/agent-runtime";
import {
	getAgentSecretStore,
	normalizeSecretScope,
	validateSecretName,
	validateSecretValue,
} from "../../secrets/agent-store";
import type { ApprovalBridge, PendingSecret } from "../approval-bridge";
import type { DaemonService } from "./types";

/**
 * SecretService — agent 密钥的设置页/卡片面（L2 宿主服务）。
 *
 * 能力缝声明：
 * - 输入：RPC `secret.status` / `secret.list` / `secret.set` / `secret.delete`
 *   （设置页的半静默管理路径），以及 `secret.answer`（应答
 *   `request_secret` 推送的待决卡片）。
 * - 输出：`AgentSecretStore` 的加密落盘（值 AES-256-GCM，元数据 0600
 *   sidecar），`notifyAgentSecretSaved` 把新值动态注册进所有活跃会话的
 *   SecretObfuscator，`ApprovalBridge.resolveSecret` 落定工具侧 promise。
 * - 生命周期：无自有状态。pending 表随 LiveSession 存活；本服务只按
 *   requestId（可选 sessionId 加速）寻址。
 *
 * 硬约束：任何返回值、异常文本与日志都不携带 value；`save` 在落定
 * promise 之前完成落盘，工具只看到 action，永远看不到值。
 */

export interface SecretLiveSession {
	approvals: ApprovalBridge;
}

export interface SecretServiceHostAccess {
	/** Resolved agent dir shared with the session runtime (master key lives here). */
	agentDir(): string;
	get(sessionId: string): SecretLiveSession | undefined;
	allSessions(): Iterable<SecretLiveSession>;
}

export class SecretService implements DaemonService {
	readonly key = "secrets";
	readonly routes = {
		"secret.status": "status",
		"secret.list": "list",
		"secret.set": "set",
		"secret.update": "update",
		"secret.delete": "delete",
		"secret.answer": "answer",
	} as const;

	readonly #deps: SecretServiceHostAccess;

	constructor(deps: SecretServiceHostAccess) {
		this.#deps = deps;
	}

	async status(): Promise<SecretStatus> {
		return await getAgentSecretStore(this.#deps.agentDir()).status();
	}

	async list(): Promise<SecretListResult> {
		const entries = await getAgentSecretStore(this.#deps.agentDir()).list();
		return { entries, count: entries.length };
	}

	async set(params: SecretSetParams): Promise<SecretSetResult> {
		const p = (params ?? {}) as Partial<SecretSetParams>;
		const name = validateSecretName(p.name);
		const value = validateSecretValue(p.value);
		// The settings page has no session context, so it cannot ask for workspace
		// scope; only a card answer resolves one from the asking session.
		if (p.scope === "workspace") {
			throw new Error("Workspace scope can only be chosen from a secret request card.");
		}
		const entry = await getAgentSecretStore(this.#deps.agentDir()).set(
			name,
			value,
			p.purpose,
			p.scope === "all" ? "all" : undefined,
			p.delivery,
		);
		// Immediate provider-boundary coverage for every live session.
		notifyAgentSecretSaved(this.#deps.agentDir(), name, value);
		return { entry };
	}

	async update(params: SecretUpdateParams): Promise<SecretUpdateResult> {
		const p = (params ?? {}) as Partial<SecretUpdateParams>;
		const name = validateSecretName(p.name);
		if (p.scope !== "all") throw new Error("Only widening to every session is supported here.");
		const entry = await getAgentSecretStore(this.#deps.agentDir()).setScope(name, "all");
		return { entry };
	}

	async delete(params: SecretDeleteParams): Promise<SecretDeleteResult> {
		const p = (params ?? {}) as Partial<SecretDeleteParams>;
		const name = validateSecretName(p.name);
		await getAgentSecretStore(this.#deps.agentDir()).delete(name);
		return { ok: true };
	}

	async answer(params: SecretAnswerParams): Promise<SecretAnswerResult> {
		const p = (params ?? {}) as Partial<SecretAnswerParams>;
		const action = p.action;
		if (action !== "save" && action !== "allow" && action !== "cancel") {
			throw new Error("Invalid secret action: must be save, allow or cancel");
		}
		const { live, pending } = this.#findPending(p.requestId, p.sessionId);
		const store = getAgentSecretStore(this.#deps.agentDir());
		if (action === "save") {
			const value = validateSecretValue(p.value);
			const scope = resolveScopeChoice(p.scope, pending.workspace);
			// `undefined` keeps what the entry already had; a new entry defaults to
			// every session, which is the pre-scope behaviour.
			await store.set(pending.name, value, pending.purpose, scope, p.delivery ?? pending.delivery);
			notifyAgentSecretSaved(this.#deps.agentDir(), pending.name, value);
		} else if (action === "allow") {
			const entry = await store.getEntry(pending.name);
			if (!entry || !(await store.available(pending.name))) {
				throw new Error(`No stored value for ${pending.name}; the user must save one first.`);
			}
			if (entry.scope !== "all") {
				if (!pending.workspace) throw new Error("This secret request has no workspace to allow.");
				await store.setScope(pending.name, normalizeSecretScope([...entry.scope, pending.workspace]));
			}
			if (entry.delivery === "file") await store.materializeFile(pending.name);
			await store.touch(pending.name);
		}
		// Resolve only after a save is durable: the tool verifies the entry on
		// wake and would otherwise see a race with the write.
		if (!live.approvals.resolveSecret(pending.requestId, action)) {
			throw new Error(`Unknown secret request: ${pending.requestId}`);
		}
		return { ok: true };
	}

	#findPending(
		requestId: string | undefined,
		sessionId: string | undefined,
	): { live: SecretLiveSession; pending: PendingSecret } {
		if (typeof requestId !== "string" || requestId.length === 0) {
			throw new Error("Missing secret requestId");
		}
		if (typeof sessionId === "string" && sessionId.length > 0) {
			const live = this.#deps.get(sessionId);
			if (!live) throw new Error(`Unknown session: ${sessionId}`);
			const pending = live.approvals.pendingSecrets.get(requestId);
			if (!pending) throw new Error(`Unknown secret request: ${requestId}`);
			return { live, pending };
		}
		for (const live of this.#deps.allSessions()) {
			const pending = live.approvals.pendingSecrets.get(requestId);
			if (pending) return { live, pending };
		}
		throw new Error(`Unknown secret request: ${requestId}`);
	}
}

/** Card choice → stored scope. `undefined` keeps what the entry already had. */
function resolveScopeChoice(
	choice: SecretScopeChoice | undefined,
	workspace: string | undefined,
): SecretScope | undefined {
	if (choice === "all") return "all";
	if (choice === "workspace") {
		if (!workspace) throw new Error("This secret request has no workspace to scope to.");
		return [path.resolve(workspace)];
	}
	return undefined;
}
