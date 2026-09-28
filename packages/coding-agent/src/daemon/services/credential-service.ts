import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@musepi/pi-utils";
import type { DaemonService } from "./types";

/**
 * CredentialService — 连接器凭据托管的统一落点（M4 P1，决策点③批复：
 * 新建 L2 服务统一凭据引用解析，daemon credential 散点不复用）。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：credentials（RPC 路由 `credentials.list` / `credentials.set` /
 *   `credentials.delete`）。
 * - 输入：set = { label, kind, secret, id? }（upsert）；delete = { id }；
 *   list 无参。连接器配置仅存凭据引用（id）——引用解析在 daemon 内部。
 * - 输出：list/set 只回**元数据**（id/label/kind/createdAt/updatedAt），
 *   永不回 secret——UI 只见「已配置」，不见密钥（M4 §4.2）。
 * - 生命周期：进程内懒加载缓存 + 写穿落盘（tmp+rename，0o600）；start/stop
 *   无副作用。
 * - 启停：always-on——凭据面是连接器 tab 的常驻数据面，无独立启停语义
 *  （声明理由：store 是用户侧资产，服务本体无状态可卸载）。
 * - 冲突：`resolve()` 是 daemon 内部方法（MCP 连接器接线消费），**不在
 *   routes 映射里**——密钥不出 store、不进 wire、不进日志（M4 §4.3 验收：
 *   wire 断言由 route-coverage + 本服务契约测试钉死）。存储文件独占
 *  `<agentDir>/credentials.json`，与 auth.json / oauth 凭据并存不混。
 *   检视入口：本文件。
 */

export const CREDENTIAL_KINDS = ["token", "basic", "env"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** wire 面元数据（永不携带 secret）。 */
export interface CredentialMeta {
	id: string;
	label: string;
	kind: CredentialKind;
	createdAt: string;
	updatedAt: string;
}

interface StoredRecord extends CredentialMeta {
	secret: string;
}

export interface CredentialServiceDeps {
	/** 凭据存储文件路径（server 侧注入 `<agentDir>/credentials.json`）。 */
	storePath: string;
}

function newCredentialId(): string {
	return `cred_${crypto.randomBytes(12).toString("base64url")}`;
}

function toMeta(record: StoredRecord): CredentialMeta {
	return {
		id: record.id,
		label: record.label,
		kind: record.kind,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export class CredentialService implements DaemonService {
	readonly key = "credentials";
	readonly routes = {
		"credentials.list": "list",
		"credentials.set": "set",
		"credentials.delete": "delete",
	} as const;

	readonly #storePath: string;
	#cache: Map<string, StoredRecord> | undefined;

	constructor(deps: CredentialServiceDeps) {
		this.#storePath = deps.storePath;
	}

	/** RPC credentials.list：元数据清单（secret 永不出现）。 */
	async list(): Promise<{ credentials: CredentialMeta[] }> {
		const cache = await this.#load();
		return { credentials: [...cache.values()].map(toMeta) };
	}

	/** RPC credentials.set：upsert（显式 id 覆盖，缺省生成）。返回元数据。 */
	async set(params: {
		id?: unknown;
		label?: unknown;
		kind?: unknown;
		secret?: unknown;
	}): Promise<{ credential: CredentialMeta }> {
		const label = typeof params.label === "string" ? params.label.trim() : "";
		if (!label) throw new Error("label required");
		const kind = CREDENTIAL_KINDS.find(k => k === params.kind);
		if (!kind) throw new Error(`kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
		if (typeof params.secret !== "string" || !params.secret) throw new Error("secret required");
		const cache = await this.#load();
		const id = typeof params.id === "string" && params.id ? params.id : newCredentialId();
		const existing = cache.get(id);
		const now = new Date().toISOString();
		const record: StoredRecord = {
			id,
			label,
			kind,
			secret: params.secret,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		cache.set(id, record);
		await this.#persist(cache);
		return { credential: toMeta(record) };
	}

	/** RPC credentials.delete：按 id 删除。返回 { ok, removed }。 */
	async delete(params: { id?: unknown }): Promise<{ ok: true; removed: boolean }> {
		if (typeof params.id !== "string" || !params.id) throw new Error("id required");
		const cache = await this.#load();
		const removed = cache.delete(params.id);
		if (removed) await this.#persist(cache);
		return { ok: true, removed };
	}

	/** daemon 内部引用解析（MCP 连接器接线消费）。不在 routes 里——
	 *  密钥不出 wire。 */
	async resolve(id: string): Promise<string | undefined> {
		return (await this.#load()).get(id)?.secret;
	}

	async #load(): Promise<Map<string, StoredRecord>> {
		if (this.#cache) return this.#cache;
		const cache = new Map<string, StoredRecord>();
		try {
			const parsed = JSON.parse(await fs.promises.readFile(this.#storePath, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					const record = item as StoredRecord;
					if (
						typeof record?.id === "string" &&
						typeof record.secret === "string" &&
						CREDENTIAL_KINDS.includes(record.kind)
					) {
						cache.set(record.id, record);
					}
				}
			}
		} catch (err) {
			if (!isEnoent(err)) {
				// 损坏的存储文件不阻断服务：回空仓 + 警告（下一次 set 会重建）。
				logger.warn("CredentialService: store unreadable, starting empty", {
					storePath: this.#storePath,
				});
			}
		}
		this.#cache = cache;
		return cache;
	}

	async #persist(cache: Map<string, StoredRecord>): Promise<void> {
		const dir = path.dirname(this.#storePath);
		await fs.promises.mkdir(dir, { recursive: true });
		const tmp = path.join(dir, `.credentials-${crypto.randomBytes(6).toString("hex")}.tmp`);
		const payload = JSON.stringify([...cache.values()]);
		await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
		await fs.promises.rename(tmp, this.#storePath);
	}
}
