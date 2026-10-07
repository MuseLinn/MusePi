/**
 * What a package declares when it ships a bundle, read without applying it.
 *
 * A DSH bundle is one npm package that contributes rows to a Loader tree: its
 * `package.json` points at a `cordis.patch.yml` (or an ordered list of them) and
 * the rows inside name plugins by npm package. That is the shape a design
 * template takes when it is distributed rather than compiled in — a template
 * arrives as a package contributing a row, not as a source edit plus a release.
 *
 * This reads that declaration and stops there. It applies no patch, builds no
 * layer stack and evaluates no expression: a bundle is a package this host
 * installed, and a value it cannot translate must be reported rather than run.
 * What it produces is an inventory — which rows a package would contribute, and
 * which of the plugins they name are not present here — so installing the
 * package can say what came with it instead of leaving the person to find out.
 *
 * The read is deliberately static for the same reason the capability report is:
 * a bundle that turns out to be incompatible must not have executed anything
 * before that verdict is known.
 *
 * 能力缝声明（M2.4）：
 * - 名称+ns：`dsh-bundle`（插件安装面，被 `capability-report` 读路径调用，
 *   无独立 RPC ns）。
 * - 输入：`describeDshBundle(pluginDir)` — 一个已安装包的目录；读该目录的
 *   `package.json` 与其 `dsh.bundle.patch` 指向的 patch 文件，逐个交给
 *   `parseDshPatch`。
 * - 输出：`DshBundleInventory` — 声明的行数、逐行 plugin 名与其在本机的
 *   解析状态（resolved / not-installed / disabled）、未能读取的 patch 文件与
 *   被丢弃的 `!!js` 表达式计数。**不施加、不挂载、不执行**。
 * - 生命周期：无进程内状态；每次调用直读盘，函数返回即结束。
 * - 启停：always-on —— 它是安装结果的一部分，没有独立启停语义（声明理由：
 *   「这个包带了什么」不是一个可被关掉的能力）。
 * - 冲突：无 —— 只读文件，不写盘、不注册、不改插件启用态；与
 *   `capability-report`（唯一调用方）单向依赖。
 *   检视入口：本文件 + `dsh-patch.ts`（行语法）+ `dsh-name-resolution.ts`
 *   （名字解析）。
 *
 * @module extensibility/plugins/dsh-bundle
 */

import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { type PluginNameResolution, resolvePluginNames } from "./dsh-name-resolution";
import { type DshPatchRow, type DshValue, parseDshPatch } from "./dsh-patch";

/** One row a bundle declares, and whether its plugin exists here. */
export interface DshBundleRow {
	readonly id: string;
	/** The npm package the row names, verbatim as the file wrote it. */
	readonly name: string;
	/** Where that name lands in this host, or why it cannot. */
	readonly resolution: PluginNameResolution;
	/**
	 * Whether the row carries a `!!js` expression this host will not evaluate.
	 *
	 * Present so a caller can say "this row's behaviour depends on an
	 * expression we do not run" rather than reading the row as unconditional.
	 * `undefined` when the row carries none.
	 */
	readonly hasUnevaluatedExpression: boolean | undefined;
}

/** A patch file the bundle declares but that could not be read. */
export interface DshBundleUnreadable {
	readonly path: string;
	readonly reason: string;
}

/** Everything one package declares, and what of it this host could account for. */
export interface DshBundleInventory {
	/** Whether the package declares a bundle at all. */
	readonly isBundle: boolean;
	/** Patch files found, in the order the manifest lists them. */
	readonly patchFiles: readonly string[];
	readonly rows: readonly DshBundleRow[];
	readonly unreadable: readonly DshBundleUnreadable[];
	/**
	 * How many `!!js` values were read and not run, across every patch file.
	 *
	 * A bundle whose whole point is a conditional row (`disabled: !!js
	 * process.platform === 'win32'`) installs and contributes nothing on this
	 * host; this count is how a caller states that instead of reporting an
	 * ordinary empty result.
	 */
	readonly unevaluatedExpressions: number;
}

/**
 * The `dsh` block of a package manifest, as the bundle grammar defines it.
 *
 * `bundle.patch` is one path or an ordered list applied in sequence
 * (`packages/util/package-manifest/src/types.ts:69-72`); the list order is the
 * composition order, so it is preserved rather than sorted.
 */
interface BundleManifest {
	readonly patch?: string | readonly string[];
}

/** Read an installed package's bundle declaration and resolve what it names. */
export async function describeDshBundle(pluginDir: string): Promise<DshBundleInventory> {
	// No directory means no manifest to read. Resolving the path against the
	// process cwd would read whatever package.json happens to sit there and
	// report that package's bundle as this plugin's.
	if (pluginDir === "") {
		return { isBundle: false, patchFiles: [], rows: [], unreadable: [], unevaluatedExpressions: 0 };
	}
	const patchFiles = await readDeclaredPatchFiles(pluginDir);
	if (patchFiles === null) {
		// Not a bundle, or no readable manifest. Not a failure: most packages
		// installed here declare no bundle at all.
		return { isBundle: false, patchFiles: [], rows: [], unreadable: [], unevaluatedExpressions: 0 };
	}

	const rows: DshBundleRow[] = [];
	const unreadable: DshBundleUnreadable[] = [];
	let unevaluatedExpressions = 0;

	for (const patchFile of patchFiles) {
		const absolute = path.resolve(pluginDir, patchFile);
		let source: string;
		try {
			source = await Bun.file(absolute).text();
		} catch (err) {
			// A bundle whose patch file is missing published something that cannot
			// be read. Report it as such rather than as a bundle with no rows.
			unreadable.push({ path: patchFile, reason: "patch file unreadable" });
			logger.debug("dsh bundle: patch file unreadable", { path: absolute, err });
			continue;
		}

		const document = parseDshPatch(source);
		unevaluatedExpressions += document.skipped.reduce((total, entry) => total + entry.droppedExpressions, 0);
		// Flattened before counting: a group's members are real rows that mount,
		// and they carry the conditions this host will not run. Counting only the
		// group would report a conditional bundle as unconditional.
		//
		// Only each row's own `disabled`, never its `config`: a group's config
		// holds its members, so counting there counts every descendant twice —
		// once under the group and once under the member that owns it.
		const flat = flattenRows(document.rows);
		for (const row of flat) {
			unevaluatedExpressions += isJsExpr(row.disabled) ? 1 : 0;
		}
		rows.push(...(await accountFor(flat, pluginDir)));
	}

	return { isBundle: true, patchFiles, rows, unreadable, unevaluatedExpressions };
}

/**
 * Every row a patch file would mount, with the groups that contain them.
 *
 * Nesting is not one level deep and not in one fixed field. A preset row's
 * children live under `config.plugins`; a `cordis:group`'s children live in
 * `config` directly; either can hold either again. Reading one field, or one
 * level, reports the preset row and nothing else: no package names, no platform
 * conditions, an install that looks empty.
 *
 * So the rule is structural rather than positional — any array in the row's
 * `config` whose elements carry an `id` and a `name` is a child list. That also
 * means a plugin's own configuration is only descended into where it looks
 * like rows, so a `config.plugins` list of strings (a preset's own plugin
 * names) is left alone rather than read as rows.
 *
 * Depth is bounded by the document, not a constant: a package nests its own
 * groups and this reader applies nothing, so recursion only enumerates.
 *
 * A child keeps its own entry and its members are appended after it, so the
 * inventory still says a bundle groups its rows. Parentage is not tracked: an
 * install report needs the flat set of what would mount, not the tree.
 */
function flattenRows(rows: readonly DshPatchRow[]): DshPatchRow[] {
	const flat: DshPatchRow[] = [];
	for (const row of rows) {
		flat.push(row);
		const children = childRows(row);
		if (children.length === 0) continue;
		flat.push(...flattenRows(children));
	}
	return flat;
}

/** The rows nested anywhere inside one row's `config`. */
function childRows(row: DshPatchRow): DshPatchRow[] {
	const children: DshPatchRow[] = [];
	// Deduplicated by row id, because that is a row's identity: a loader keys
	// rows by it and a later layer patches by it, so two records sharing one id
	// are one row.
	const seen = new Set<string>();
	for (const list of childLists(row.config)) {
		for (const child of list) {
			// A child without both is not a row; the parser applies that rule at
			// the top level and it applies at every level below it too.
			if (!isRow(child)) continue;
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			children.push({
				id: child.id,
				name: child.name,
				disabled: nestedValue(child.disabled),
				config: nestedValue(child.config),
				inject: Array.isArray(child.inject)
					? child.inject.filter((n: unknown): n is string => typeof n === "string")
					: [],
				group: child.group === true,
			});
		}
	}
	return children;
}

/**
 * Every value inside a `config` that is an array of id-and-name records.
 *
 * Returns the lists found, not the rows: a row's members are its own business,
 * and returning them from here would make every level claim every descendant.
 * `flattenRows` walks the resulting rows in turn, which is what puts a row at
 * the level it actually sits.
 *
 * Visited-set guarded because the walk descends into the arrays it collects:
 * without it the collected list is itself re-entered and the walk never
 * terminates. The guard is a set rather than a depth cap so that a genuinely
 * deep document is read to the end rather than truncated at a number picked
 * to stop a loop.
 */
function childLists(config: DshValue | undefined): Record<string, unknown>[][] {
	if (config === undefined || config === null || typeof config !== "object") return [];
	const found: Record<string, unknown>[][] = [];
	const seen = new Set<object>();
	const walk = (value: DshValue): void => {
		if (value === null || typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			if (
				value.length > 0 &&
				value.every(entry => entry !== null && typeof entry === "object" && !Array.isArray(entry))
			) {
				// Collected and *not* descended: these entries are rows, and their
				// own `config` holds their children. `flattenRows` walks those at
				// the level they sit, which is the only way a member is counted
				// once — descending here would hand it up to the enclosing row,
				// so the inventory would report the group's members twice and say
				// a bundle ships more rows than it mounts.
				found.push(value as Record<string, unknown>[]);
				return;
			}
			for (const entry of value) walk(entry);
			return;
		}
		for (const nested of Object.values(value)) walk(nested);
	};
	walk(config);
	return found;
}

/**
 * A record read straight out of a parsed config, before it becomes a row.
 *
 * The fields are unknown rather than typed: they came from a YAML document, so
 * each is checked where it is used rather than trusted here. Only `id` and
 * `name` are narrowed, because those two are what make it a row at all.
 */
interface NestedRecord {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly disabled?: unknown;
	readonly config?: unknown;
	readonly inject?: unknown;
	readonly group?: unknown;
}

/** Whether a record carries the two fields that make it a row. */
function isRow(value: unknown): value is { readonly id: string; readonly name: string } & NestedRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && record.id !== "" && typeof record.name === "string" && record.name !== "";
}

/** Read a nested record's `disabled`, dropping anything that is not a value. */
function nestedValue(value: unknown): DshValue | undefined {
	return value === undefined ? undefined : (value as DshValue);
}

/** Rows, each paired with the state of the plugin it names. */
async function accountFor(rows: readonly DshPatchRow[], pluginDir: string): Promise<DshBundleRow[]> {
	const resolutions = await resolvePluginNames(
		rows.map(row => row.name),
		pluginDir,
	);
	const byName = new Map(resolutions.map(entry => [entry.name, entry.resolution]));
	return rows.map(row => ({
		id: row.id,
		name: row.name,
		// A name the bundle repeats resolves once; the map is what makes the
		// second occurrence report the same state instead of a default.
		resolution: byName.get(row.name) ?? { status: "not-installed" },
		hasUnevaluatedExpression: row.disabled === undefined ? undefined : isJsExpr(row.disabled),
	}));
}

/**
 * Whether a read value carries an expression this host does not run.
 *
 * Walks the structure because `disabled` is not the only place one appears: a
 * row's `config` nests them arbitrarily deep, and a bundle that gates a whole
 * group behind one expression reports nothing on the row that carries it.
 */
function isJsExpr(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.kind === "js-expr") return true;
	return Object.values(record).some(isJsExpr);
}

/**
 * The patch files a package declares, in composition order.
 *
 * `null` distinguishes "declares no bundle" from "declares a bundle with an
 * empty list", which would be a package that contributes nothing.
 */
async function readDeclaredPatchFiles(pluginDir: string): Promise<string[] | null> {
	let manifest: { dsh?: { bundle?: BundleManifest } };
	try {
		manifest = (await Bun.file(path.join(pluginDir, "package.json")).json()) as typeof manifest;
	} catch {
		return null;
	}
	const declared = manifest.dsh?.bundle?.patch;
	if (typeof declared === "string") return declared.trim() === "" ? [] : [declared];
	if (Array.isArray(declared)) {
		return declared.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
	}
	return null;
}
