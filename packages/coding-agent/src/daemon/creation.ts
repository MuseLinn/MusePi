/**
 * Creation surface storage (M3.2) — docs/review/0.5.0-m3.1-creation-surface-design.md
 * §4 (project metadata 契约) + §3.4 (会话模板) + §4 双写镜像。
 *
 * 纯领域模块：零 daemon 运行时依赖；目录一律参数注入（默认解析集中在
 * creationTemplatesDir()），测试传显式 tmp 目录，绝不触碰用户配置根。
 *
 * 三块职责：
 * 1. validateProjectMetadata —— project metadata 形状/版本/16KiB 上限校验
 *    （session.create 与模板保存共用；超限给语义报错）。
 * 2. 会话模板 CRUD —— `~/.musepi/creation-templates/<id>.json`，一模板一
 *    文件（与 modes/ 同款布局）；坏文件跳过不炸列表。
 * 3. .musepi/project.json 镜像 —— 工作目录侧的恢复/分享/artifact-scan
 *    关联源（daemon 会话头是权威，镜像是尽力而为的副本）。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@musepi/pi-utils";

/** Metadata size cap (§4: 16KiB)。 */
export const PROJECT_METADATA_LIMIT_BYTES = 16 * 1024;

/** Template tab ids that a saved template can originate from. "template"
 *  itself is a management view — you cannot save a template from it. */
export const CREATION_TEMPLATE_TABS = ["prototype", "live-artifact", "deck", "media", "other"] as const;
export type CreationTemplateTab = (typeof CREATION_TEMPLATE_TABS)[number];

/** Template file id charset — the id becomes a filename, so this is also
 *  the path-traversal guard (reject `..`, separators, anything exotic). */
const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a `projectMetadata` payload (§4 契约): JSON object, `version`
 * present (= 1 until a migration exists), serialized size ≤16KiB. Throws
 * semantic errors — the RPC surface turns them into JSON-RPC error messages
 * the GUI banner shows verbatim.
 *
 * M3.7c (mode-page-redesign §4) value-checks the `assetPolicy` key on the
 * same fail-fast path as the design-system id (unknown `designSystemId`
 * errors in `session.setDesignSystem`): the key itself rides the open
 * metadata object like every creation-surface key, but a present value
 * outside `"ai-image" | "placeholder"` is a semantic error — persisting an
 * unknown policy would silently inject nothing and read as "selected".
 */
export function validateProjectMetadata(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("project metadata must be a JSON object");
	}
	const metadata = value as Record<string, unknown>;
	if (!("version" in metadata)) {
		throw new Error('project metadata is missing the required "version" field (expected 1)');
	}
	if (metadata.version !== 1) {
		throw new Error(`unsupported project metadata version: ${String(metadata.version)} (expected 1)`);
	}
	if ("assetPolicy" in metadata && metadata.assetPolicy !== "ai-image" && metadata.assetPolicy !== "placeholder") {
		throw new Error(
			`invalid asset policy: ${JSON.stringify(metadata.assetPolicy)} (expected "ai-image" or "placeholder")`,
		);
	}
	const bytes = new TextEncoder().encode(JSON.stringify(metadata)).length;
	if (bytes > PROJECT_METADATA_LIMIT_BYTES) {
		throw new Error(
			`project metadata is ${bytes} bytes, over the 16 KiB limit (${PROJECT_METADATA_LIMIT_BYTES}) — trim fields (e.g. long prompt templates) before creating`,
		);
	}
	return metadata;
}

// ═══════════════════════════════════════════════════════════════════════════
// Session templates (~/.musepi/creation-templates/<id>.json)
// ═══════════════════════════════════════════════════════════════════════════

export interface CreationTemplate {
	version: 1;
	id: string;
	/** 用户可读名（默认取项目名）。 */
	name?: string;
	/** 模板来源 tab —— 应用时决定 rail 过滤与字段回填域。 */
	tab: CreationTemplateTab;
	/** 完整 project metadata 快照（§4 形状,含 kind/skillId 等解析结果）。 */
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/** 模板目录：默认 `~/.musepi/creation-templates`；env 覆盖只服务测试/便携布局。 */
export function creationTemplatesDir(): string {
	const override = process.env.MUSEPI_CREATION_TEMPLATES_DIR;
	if (override) return override;
	return path.join(getConfigRootDir(), "creation-templates");
}

/** List saved templates (newest-updated first). Broken files are skipped —
 *  one hand-edited JSON must never empty the Template tab. */
export async function listCreationTemplates(dir: string = creationTemplatesDir()): Promise<CreationTemplate[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const templates: CreationTemplate[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(await Bun.file(path.join(dir, name)).text()) as CreationTemplate;
			if (typeof parsed?.id === "string" && typeof parsed?.metadata === "object") {
				templates.push(parsed);
			}
		} catch {
			// Corrupt template file — skip it, keep the rest of the list alive.
		}
	}
	templates.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
	return templates;
}

/** Save (upsert) a template. `metadata` is re-validated so the 16KiB cap
 *  holds for templates too. Returns the persisted record. */
export async function saveCreationTemplate(
	params: { id?: string; name?: string; tab: CreationTemplateTab; metadata: unknown },
	dir: string = creationTemplatesDir(),
): Promise<CreationTemplate> {
	const metadata = validateProjectMetadata(params.metadata);
	const id = params.id ?? `tpl-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
	if (!TEMPLATE_ID_RE.test(id)) {
		throw new Error(`invalid creation template id: ${JSON.stringify(id)}`);
	}
	const existing = await readTemplateFile(dir, id);
	const now = new Date().toISOString();
	const template: CreationTemplate = {
		version: 1,
		id,
		...(params.name?.trim() ? { name: params.name.trim() } : existing?.name ? { name: existing.name } : {}),
		tab: params.tab,
		metadata,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	// Bun.write auto-creates parent dirs.
	await Bun.write(path.join(dir, `${id}.json`), JSON.stringify(template, null, "\t"));
	return template;
}

/** Delete a template by id. Missing id → false (idempotent), bad id → throw. */
export async function deleteCreationTemplate(id: string, dir: string = creationTemplatesDir()): Promise<boolean> {
	if (!TEMPLATE_ID_RE.test(id)) {
		throw new Error(`invalid creation template id: ${JSON.stringify(id)}`);
	}
	try {
		await fs.rm(path.join(dir, `${id}.json`));
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function readTemplateFile(dir: string, id: string): Promise<CreationTemplate | null> {
	if (!TEMPLATE_ID_RE.test(id)) return null;
	try {
		return JSON.parse(await Bun.file(path.join(dir, `${id}.json`)).text()) as CreationTemplate;
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// .musepi/project.json mirror (§4 双写)
// ═══════════════════════════════════════════════════════════════════════════

/** Read the mirror for a working directory. Missing/corrupt → null (the
 *  daemon session header is the authority; the mirror is best-effort). */
export async function readProjectMirror(cwd: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed = JSON.parse(await Bun.file(path.join(cwd, ".musepi", "project.json")).text());
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Write the mirror. Caller has already validated the metadata. Creates
 *  `<cwd>/.musepi/` on demand. */
export async function writeProjectMirror(cwd: string, metadata: Record<string, unknown>): Promise<void> {
	await Bun.write(path.join(cwd, ".musepi", "project.json"), JSON.stringify(metadata, null, "\t"));
}
