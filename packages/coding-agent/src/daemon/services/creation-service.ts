import type { SessionHeader } from "@musepi/pi-wire";
import {
	CREATION_TEMPLATE_TABS,
	type CreationTemplate,
	type CreationTemplateTab,
	deleteCreationTemplate,
	listCreationTemplates,
	readProjectMirror,
	saveCreationTemplate,
	validateProjectMetadata,
} from "../creation";
import type { DaemonService } from "./types";

/**
 * CreationService — 创作面（M3.2）数据面 L2 宿主服务。
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：creation（RPC 路由 `creation.templates.*` / `creation.metadata.get`）。
 * - 输入：`creation.templates.list`（列模板）、`creation.templates.save`
 *   （保存/覆盖，metadata 走 validateProjectMetadata ≤16KiB 校验）、
 *   `creation.templates.delete`、`creation.metadata.get`（sessionId 权威头
 *   或 cwd `.musepi/project.json` 镜像，二选一读回）。
 * - 输出：`~/.musepi/creation-templates/<id>.json` 的读写视图（一模板一
 *   文件）；metadata.get 返回 `{ metadata: object | null }`（软错误约定，
 *   镜像缺失/损坏返 null 不抛）。
 * - 生命周期：无进程内状态——每次调用直读/直写盘；start/stop 无副作用。
 * - 启停：always-on——创作面板的基础数据面，无独立启停语义（声明理由：
 *   模板文件即用户侧开关，服务本体无状态可卸载）。
 * - 冲突：无——存储目录 `~/.musepi/creation-templates/` 独占，与 modes/、
 *   boards/ 无交集；metadata 镜像写入归 session-host（创建路径），本服务只读。
 *   检视入口：本文件 + `daemon/creation.ts`（领域模块，含 §4 校验）。
 */
export class CreationService implements DaemonService {
	readonly key = "creation";
	readonly routes = {
		"creation.templates.list": "listTemplates",
		"creation.templates.save": "saveTemplate",
		"creation.templates.delete": "deleteTemplate",
		"creation.metadata.get": "getMetadata",
	} as const;

	/** 结构依赖：按 sessionId 读 view-store 快照头（server 侧注入
	 *  host.viewStore.load），避免本服务对宿主产生传递依赖。 */
	readonly #loadHeader?: (sessionId: string) => SessionHeader | null | undefined;

	constructor(deps?: { loadHeader?: (sessionId: string) => SessionHeader | null | undefined }) {
		this.#loadHeader = deps?.loadHeader;
	}

	/** RPC creation.templates.list：新 updatedAt 在前（模板 rail/列表序）。 */
	async listTemplates(): Promise<{ templates: CreationTemplate[] }> {
		return { templates: await listCreationTemplates() };
	}

	/** RPC creation.templates.save：upsert（带 id 覆盖，缺 id 新建）。 */
	async saveTemplate(params: {
		id?: unknown;
		name?: unknown;
		tab?: unknown;
		metadata?: unknown;
	}): Promise<{ ok: true; template: CreationTemplate }> {
		const p = params ?? {};
		if (typeof p.tab !== "string" || !CREATION_TEMPLATE_TABS.includes(p.tab as CreationTemplateTab)) {
			throw new Error(`creation.templates.save: unknown tab ${JSON.stringify(p.tab ?? null)}`);
		}
		const metadata = validateProjectMetadata(p.metadata);
		return {
			ok: true,
			template: await saveCreationTemplate({
				id: typeof p.id === "string" && p.id ? p.id : undefined,
				name: typeof p.name === "string" ? p.name : undefined,
				tab: p.tab as CreationTemplateTab,
				metadata,
			}),
		};
	}

	/** RPC creation.templates.delete：幂等（不存在 ok:false 不抛）。 */
	async deleteTemplate(params: { id?: unknown }): Promise<{ ok: boolean }> {
		const id = params?.id;
		if (typeof id !== "string" || !id) throw new Error("creation.templates.delete: id is required");
		return { ok: await deleteCreationTemplate(id) };
	}

	/** RPC creation.metadata.get：sessionId 优先（daemon 会话头权威），
	 *  cwd 兜底（.musepi/project.json 镜像）。GUI 创作面板再入回填消费。 */
	async getMetadata(params: {
		sessionId?: unknown;
		cwd?: unknown;
	}): Promise<{ metadata: Record<string, unknown> | null }> {
		const p = params ?? {};
		if (typeof p.sessionId === "string" && p.sessionId) {
			if (!this.#loadHeader) throw new Error("creation.metadata.get: session lookup unavailable");
			const header = this.#loadHeader(p.sessionId);
			return { metadata: header?.projectMetadata ?? null };
		}
		if (typeof p.cwd === "string" && p.cwd) {
			return { metadata: await readProjectMirror(p.cwd) };
		}
		throw new Error("creation.metadata.get: sessionId or cwd is required");
	}
}
