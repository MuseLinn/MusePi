/**
 * PresetsService — agent presets (modes) as an L2 daemon service.
 *
 * Seam:
 * - Input: `modes.*` (settings editor) and `agentPresets.*` (dsh parity)
 *   routes, the modes directory, the session/header store for per-session
 *   selection, and the extension registry that contributes preset sources.
 * - Output: summary rows, one preset's full document, validation verdicts, and
 *   save/delete/select acks. Every write broadcasts `modes-changed`.
 * - Lifecycle: stateless. Presets are files under the modes directory plus
 *   profile/extension code layers; this service only reads and writes them.
 *
 * Lookup order is file > profile > extension code, matching
 * `createModeResolver`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import YAML from "yaml";
import type { DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

/** Extension row these presets need: identity, mount path, and the
 *  kind/state pair `collectExtensionModes` filters on. */
export interface KnownExtension {
	id: string;
	kind: string;
	state: string;
	path: string;
}

export interface PresetsServiceDeps {
	modesDir(): string;
	knownExtensions(): Promise<readonly KnownExtension[]>;
	broadcastModesChanged(): void;
}

export class PresetsService implements DaemonService {
	readonly key = "presets";
	readonly routes = {
		"modes.list": "list",
		"modes.getDefault": "getDefault",
		"modes.setDefault": "setDefault",
		"modes.get": "get",
		"modes.save": "save",
		"modes.delete": "remove",
		"modes.validate": "validate",
		"agentPresets.list": "agentPresets",
		"agentPresets.read": "agentPreset",
		"agentPresets.select": "selectAgentPreset",
	} as const;

	constructor(
		private readonly host: Pick<DaemonSessionHost, "cwd" | "get" | "persistHeaderPatch"> & PresetsServiceDeps,
	) {}

	/** P0-② 挂载校验：白名单扩展实际加载 + 槽位组件编译。不建会话
	 *  （standingKeyFor 即「真实挂载但不建 agent」）。 */
	async #validateModeMounting(def: { extensions?: string[] }, errors: string[]): Promise<void> {
		const extensions = def.extensions ?? [];
		if (extensions.length === 0) return;
		const cwd = this.host.cwd();
		const { loadExtensions } = await import("../../extensibility/extensions/loader");
		const { validateExtensionComponents } = await import("../extension-artifact-compiler");
		const known = await this.host.knownExtensions();
		for (const id of extensions) {
			const entry = known.find(e => e.id === id);
			if (!entry) continue; // 未找到已由 validateMode 报
			const result = await loadExtensions([entry.path], cwd);
			if (result.errors.length > 0) {
				for (const err of result.errors) errors.push(`扩展 "${id}" 加载失败: ${err.error}`);
				continue;
			}
			const ext = result.extensions[0];
			if (!ext) {
				errors.push(`扩展 "${id}" 加载后为空`);
				continue;
			}
			const bad = await validateExtensionComponents(ext);
			for (const c of bad) errors.push(`扩展 "${id}" 组件 "${c.moduleUrl}" 编译失败: ${c.error}`);
		}
	}

	async list(params: unknown): Promise<unknown> {
		// 预设中心数据源(docs/archive/modes-plan.md §7):摘要列表,含继承链与
		// 结构信息;扩展 id 存在性校验在 save/validate 层做。
		const { listModeIds, loadModeFile, ensureModeTemplates, BUILTIN_MODE_TEMPLATES } = await import(
			"../../presets/resolve"
		);
		const { t } = await import("../../i18n/index.js");
		const dir = this.host.modesDir();
		ensureModeTemplates(dir);
		const ids = listModeIds(dir);
		const modes: Array<{
			id: string;
			builtin: boolean;
			label?: string;
			description?: string;
			extends: string[];
			extensions?: string[];
			hasPrompt: boolean;
			promptComplete: boolean;
			settingsKeys: string[];
			plugins?: { name: string; id?: string; enabled?: boolean }[];
			source?: "extension";
		}> = ids.map(id => {
			const def = loadModeFile(dir, id);
			// 内置模板(work/chat/design/creator)显示名走 i18n(BUILT_IN_PRESET_KEYS
			// 对齐);用户自定义用文件 label。
			const builtinName = t(`preset ${id} name` as never);
			const builtinDesc = t(`preset ${id} description` as never);
			const isBuiltinLabel = !builtinName.startsWith("preset ");
			return {
				id,
				builtin: id in BUILTIN_MODE_TEMPLATES,
				label: isBuiltinLabel ? builtinName : (def?.label ?? id),
				description: isBuiltinLabel ? builtinDesc : def?.description,
				extends: def?.extends ?? [],
				extensions: def?.extensions,
				hasPrompt: (def?.prompt?.length ?? 0) > 0,
				promptComplete: def?.promptComplete === true,
				settingsKeys: Object.keys(def?.settings ?? {}),
				// The composition travels with the preset: which plugins it stacks,
				// in order, with the enable switch. A preset IS a plugin composition,
				// and a summary that carried only its prompt/settings could not answer
				// "what does switching to this preset install?".
				plugins: def?.plugins ?? [],
			};
		});
		const fileIds = new Set(ids);
		const { collectProfilePresetDefinitions } = await import("../../extensibility/plugins/profile/profile-presets");
		for (const def of await collectProfilePresetDefinitions(this.host.cwd(), os.homedir())) {
			if (fileIds.has(def.id)) continue;
			fileIds.add(def.id);
			modes.push({
				id: def.id,
				builtin: false,
				label: def.label,
				description: def.description,
				extends: def.extends ?? [],
				extensions: def.extensions,
				hasPrompt: (def.prompt?.length ?? 0) > 0,
				promptComplete: def.promptComplete === true,
				settingsKeys: Object.keys(def.settings ?? {}),
				plugins: def.plugins ?? [],
				source: "extension",
			});
		}
		// 文件 > profile > 扩展代码层，与 createModeResolver 的查找优先级一致。
		const { collectExtensionModes } = await import("../extension-artifact-compiler");
		for (const em of await collectExtensionModes(await this.host.knownExtensions(), this.host.cwd())) {
			if (fileIds.has(em.id)) continue;
			fileIds.add(em.id);
			modes.push(em);
		}
		return { modes, modesDir: dir };
	}

	async getDefault(params: unknown): Promise<unknown> {
		const { readDefaultPresetId } = await import("../../extensibility/plugins/profile/profile-presets");
		return { id: await readDefaultPresetId(this.host.cwd(), os.homedir()) };
	}

	async setDefault(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { id?: unknown };
		if (typeof p.id !== "string" || p.id === "") throw new Error("mode id is required");
		const { writeDefaultPresetId } = await import("../../extensibility/plugins/profile/profile-presets");
		const id = await writeDefaultPresetId(this.host.cwd(), os.homedir(), p.id);
		this.host.broadcastModesChanged();
		return { ok: true, id };
	}

	async get(params: unknown): Promise<unknown> {
		// 单预设完整定义(设置页编辑器用):modes.list 是摘要,编辑页
		// 按需拉完整(含 prompt 区块数组/settings 覆盖)。
		const { loadModeFile, ensureModeTemplates } = await import("../../presets/resolve");
		const p = (params ?? {}) as { id: string };
		const dir = this.host.modesDir();
		ensureModeTemplates(dir);
		const def = loadModeFile(dir, p.id);
		if (!def) throw new Error(`Unknown mode: ${p.id}`);
		return def;
	}

	async save(params: unknown): Promise<unknown> {
		// 保存 = 校验(结构 + 环/悬空 + 扩展存在性)→ 写文件 → 广播。
		const {
			loadModeFile,
			resolveMode,
			validateMode,
			MODE_ID_PATTERN,
			modeFilePath,
			ensureModeTemplates,
			BUILTIN_MODE_TEMPLATES,
		} = await import("../../presets/resolve");
		const p = (params ?? {}) as {
			id: string;
			label?: string;
			description?: string;
			extends?: string[];
			extensions?: string[];
			prompt?: unknown[];
			promptComplete?: boolean;
			runtimeContext?: boolean;
			settings?: Record<string, unknown>;
		};
		if (!MODE_ID_PATTERN.test(p.id)) throw new Error(`invalid mode id: ${p.id}`);
		// 内置预设(work/chat/design/creator)不可被保存覆盖(
		// system preset 对齐:shipped 预设属于部署,authoring 拒绝写)。
		// 与 modes.delete 同一 guard;手改磁盘文件仍允许(文件级自由)。
		if (p.id in BUILTIN_MODE_TEMPLATES) {
			throw new Error(`built-in preset "${p.id}" cannot be overwritten — copy it to a new id instead`);
		}
		const dir = this.host.modesDir();
		ensureModeTemplates(dir);
		const knownExtensions = (await this.host.knownExtensions()).map(e => e.id);
		const def = {
			id: p.id,
			label: p.label,
			description: p.description,
			extends: p.extends,
			extensions: p.extensions,
			prompt: p.prompt as never,
			promptComplete: p.promptComplete,
			runtimeContext: p.runtimeContext,
			settings: p.settings,
		};
		const errors = validateMode(def as never, { knownExtensions });
		if (errors.length > 0) throw new Error(`mode validation failed:\n${errors.join("\n")}`);
		// 环/悬空引用经 resolveMode 验证(knownExtensions 同样参与)。
		// 新建时文件尚不存在 —— 顶层 id 用内存 def(否则 load 命中
		// undefined 报"未定义的预设"),继承链其余 id 仍走文件。
		resolveMode(p.id, mid => (mid === p.id ? (def as never) : loadModeFile(dir, mid)), {
			knownExtensions,
		});
		const file = modeFilePath(dir, p.id);
		fs.writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`, "utf8");
		this.host.broadcastModesChanged();
		return { ok: true };
	}

	async remove(params: unknown): Promise<unknown> {
		const { listModeIds, loadModeFile, modeFilePath, MODE_ID_PATTERN, BUILTIN_MODE_TEMPLATES } = await import(
			"../../presets/resolve"
		);
		const p = (params ?? {}) as { id: string };
		if (!MODE_ID_PATTERN.test(p.id)) throw new Error(`invalid mode id: ${p.id}`);
		// 内置预设(work/chat/design/creator)不可删。
		if (p.id in BUILTIN_MODE_TEMPLATES) throw new Error(`built-in preset "${p.id}" cannot be deleted`);
		const dir = this.host.modesDir();
		const referencing = listModeIds(dir).filter(
			other => other !== p.id && (loadModeFile(dir, other)?.extends ?? []).includes(p.id),
		);
		if (referencing.length > 0) {
			throw new Error(`mode "${p.id}" is referenced by: ${referencing.join(", ")}`);
		}
		try {
			fs.rmSync(modeFilePath(dir, p.id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.host.broadcastModesChanged();
		return { ok: true };
	}

	async validate(params: unknown): Promise<unknown> {
		const { loadModeFile, resolveMode, validateMode, MODE_ID_PATTERN } = await import("../../presets/resolve");
		const p = (params ?? {}) as { id: string };
		if (!MODE_ID_PATTERN.test(p.id)) return { valid: false, errors: [`invalid mode id: ${p.id}`] };
		const dir = this.host.modesDir();
		const knownExtensions = (await this.host.knownExtensions()).map(e => e.id);
		const errors: string[] = [];
		try {
			const def = loadModeFile(dir, p.id);
			if (!def) errors.push(`mode "${p.id}" not found`);
			else {
				errors.push(...validateMode(def as never, { knownExtensions }));
				resolveMode(p.id, mid => loadModeFile(dir, mid), { knownExtensions });
				// P0-② 挂载校验:白名单扩展
				// 实际加载 + 槽位组件编译。不建会话(standingKeyFor 即
				// "真实挂载但不建 agent")。
				await this.#validateModeMounting(def as never, errors);
			}
		} catch (error) {
			errors.push(String((error as Error).message));
		}
		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	async agentPresets(params: unknown): Promise<unknown> {
		// dsh's `agentPresets.list`: every declarative preset source — file
		// presets, profile presets, and modes contributed by extensions (the
		// host registry is populated by mounts and by the daemon preload).
		// File presets win an id collision.
		const { listModeIds, loadModeFile, ensureModeTemplates } = await import("../../presets/resolve");
		const { readDefaultPresetId, collectProfilePresetDefinitions } = await import(
			"../../extensibility/plugins/profile/profile-presets"
		);
		const { listHostExtensionModes } = await import("../../extensibility/extensions/host-modes");
		const dir = this.host.modesDir();
		ensureModeTemplates(dir);
		const home = os.homedir();
		const defaultId = await readDefaultPresetId(this.host.cwd(), home);
		const presets: Array<{
			id: string;
			name: string;
			description?: string;
			order: number;
			default: boolean;
			source: "file" | "profile" | "extension";
		}> = [];
		const seen = new Set<string>();
		for (const [index, id] of listModeIds(dir).entries()) {
			const def = loadModeFile(dir, id);
			presets.push({
				id,
				name: def?.label ?? id,
				description: def?.description,
				order: index,
				default: id === defaultId,
				source: "file",
			});
			seen.add(id);
		}
		for (const def of await collectProfilePresetDefinitions(this.host.cwd(), home)) {
			if (seen.has(def.id)) continue;
			presets.push({
				id: def.id,
				name: def.label ?? def.id,
				description: def.description,
				order: presets.length,
				default: def.id === defaultId,
				source: "profile",
			});
			seen.add(def.id);
		}
		for (const { mode } of listHostExtensionModes()) {
			if (seen.has(mode.id)) continue;
			presets.push({
				id: mode.id,
				name: mode.label ?? mode.id,
				description: mode.description,
				order: 1000 + presets.length,
				default: mode.id === defaultId,
				source: "extension",
			});
			seen.add(mode.id);
		}
		return { presets };
	}

	async agentPreset(params: unknown): Promise<unknown> {
		// dsh's `agentPresets.read`: the preset's document. File presets return
		// their YAML bytes; profile and extension presets are serialized here
		// (dynamic prompt text is shown as a placeholder, never as code).
		const { loadModeFile, modeFilePath, ensureModeTemplates } = await import("../../presets/resolve");
		const { collectProfilePresetDefinitions } = await import("../../extensibility/plugins/profile/profile-presets");
		const { listHostExtensionModes } = await import("../../extensibility/extensions/host-modes");
		const p = (params ?? {}) as { agentPreset?: string; id?: string };
		const id = p.agentPreset ?? p.id;
		if (typeof id !== "string" || id === "") throw new Error("agentPreset is required");
		const dir = this.host.modesDir();
		ensureModeTemplates(dir);
		if (loadModeFile(dir, id)) {
			return { id, document: fs.readFileSync(modeFilePath(dir, id), "utf8"), source: "file" };
		}
		const home = os.homedir();
		const profile = (await collectProfilePresetDefinitions(this.host.cwd(), home)).find(def => def.id === id);
		if (profile) return { id, document: YAML.stringify(profile), source: "profile" };
		const mode = listHostExtensionModes().find(entry => entry.mode.id === id)?.mode;
		if (mode) {
			const document = {
				...mode,
				prompt: mode.prompt?.map(section => ({
					...section,
					text: typeof section.text === "string" ? section.text : "<dynamic>",
				})),
			};
			return { id, document: YAML.stringify(document), source: "extension" };
		}
		throw new Error(`Unknown agent preset: ${id}`);
	}

	async selectAgentPreset(params: unknown): Promise<unknown> {
		// dsh's `agentPresets.select`: switch the session's preset and persist
		// it in the session header (stored as `modeId`, read back as agentPreset).
		const p = (params ?? {}) as { sessionId?: string; agentPreset?: string | null };
		if (typeof p.sessionId !== "string" || p.sessionId === "") throw new Error("sessionId is required");
		const id = p.agentPreset ?? null;
		const live = this.host.get(p.sessionId);
		if (live) {
			const result = await live.agentSession.setMode(id, { hot: true });
			if (!result.ok) throw new Error(result.error ?? "preset switch failed");
			if (!result.deferred) this.host.persistHeaderPatch(p.sessionId, { modeId: id });
			return { ok: true, deferred: result.deferred === true, agentPreset: id };
		}
		if (!this.host.persistHeaderPatch(p.sessionId, { modeId: id })) {
			throw new Error(`Unknown session: ${p.sessionId}`);
		}
		return { ok: true, persisted: true, agentPreset: id };
	}
}
