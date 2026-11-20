/**
 * MusePi plugin index — the `musepi-plugin-index` document, format 1.
 *
 * A **market** publishes one **index**: everything a list page renders
 * (localized title/description, icon, author, versions, publish time) in a
 * single JSON document, so browsing costs one read instead of one request per
 * row. It is separate from the Claude-compatible **catalog**
 * (`.omp-plugin/marketplace.json`), which remains supported for sources that
 * ship one. The index is not an install recipe: it pins each version to a
 * structured `source`, and the host derives the installer argument itself.
 *
 * Vocabulary used here and in `docs/marketplace.md`:
 * - **plugin**: a capability bundle. Every plugin ultimately runs on the
 *   Cordis runtime; the axis below says which host lineage's manifest and
 *   content layout it declares.
 * - **vendor**: the host lineage a plugin declares. `"musepi"` is native
 *   (`package.json` `musepi` block), `"pi"` is the upstream pi lineage
 *   (`package.json` `omp`/`pi` block, one value for both), `"claude"` is
 *   `.claude-plugin/plugin.json`, and `"codex"` is
 *   `.codex-plugin/plugin.json`.
 * - **compat plugin**: a non-`musepi` vendor, loaded through the
 *   compatibility layer. Vendor is an index claim: the installed artifact
 *   decides the actual support level, which differs per vendor.
 * - **lane**: one partition of the market list. Native plugins (`musepi`) fill
 *   the main lane; `pi`, `claude`, and `codex` sit in the compat lane with a
 *   vendor badge, never mixed into the main lane.
 * - **dock**: a fixed GUI seat a *loaded* plugin may claim
 *   (`conversation.composer.dock`, the right-side panel). Browsing or
 *   installing does not create a dock; enabling a plugin can.
 *
 * Reading rules (all checked here, all reported at once):
 * - The whole index is rejected when any rule in the root, plugin, version, or
 *   source tables fails. A market that references an undeclared category,
 *   label, or sort key has a generator bug, and dropping the entry silently
 *   would hide it.
 * - Unknown members are dropped at every level and listed in the diagnostics,
 *   so a newer writer's extra fields never break an older reader and never
 *   pass unnoticed.
 * - Versions are exact SemVer. Ranges, tags, and `latest` are not versions and
 *   are rejected: the installed build must match the metadata the list showed.
 *
 * `parsePluginIndex` returns every diagnostic with a JSON path instead of
 * throwing on the first defect. `installSpec` and `selectDefaultVersion` are
 * the only places the host turns an index entry into an install.
 *
 * @module extensibility/plugins/marketplace/index-format
 */

import type { MarketplaceCatalogOwner } from "./types";
import { isValidNameSegment } from "./types";

/** The only index format this reader accepts. */
export const PLUGIN_INDEX_FORMAT = 1 as const;

/**
 * The host lineage a listed plugin declares.
 *
 * - `musepi`: native; manifest is the `package.json` `musepi` block.
 * - `pi`: upstream pi lineage; manifest is the `package.json` `omp` or `pi`
 *   block (same lineage, one value).
 * - `claude`: `.claude-plugin/plugin.json`.
 * - `codex`: `.codex-plugin/plugin.json`.
 */
export type PluginVendor = "musepi" | "pi" | "claude" | "codex";

/** A string, or an object of language-id → string (at least one entry). */
export type LocalizedText = string | Readonly<Record<string, string>>;

/** Owner declaration shared with the Claude-compatible catalog shape. */
export type PluginIndexOwner = MarketplaceCatalogOwner;

/** One declared category or label. */
export interface PluginIndexDeclaration {
	readonly title: LocalizedText;
}

/** One declared sort key: its display title and the initial sort direction. */
export interface PluginIndexSortKeyDeclaration {
	readonly title: LocalizedText;
	readonly order: "asc" | "desc";
}

/** Root declaration maps. Absent maps normalize to empty objects. */
export interface PluginIndexDeclarations {
	readonly categories: Readonly<Record<string, PluginIndexDeclaration>>;
	readonly labels: Readonly<Record<string, PluginIndexDeclaration>>;
	readonly sortKeys: Readonly<Record<string, PluginIndexSortKeyDeclaration>>;
}

/**
 * Where one exact version installs from — the index's `source` field.
 *
 * Not to be confused with a configured index location
 * (`PluginIndexSourceConfig` in `index-source.ts`): the location says where the
 * index JSON lives, this says where the plugin package lives, and only this
 * one is turned into an installer argument.
 */
export type PluginIndexSource =
	| {
			/** Installed as a registry package; `registry` is applied to this install only. */
			readonly type: "npm";
			/** Optional registry URL without credentials, query, or fragment. */
			readonly registry?: string;
	  }
	| {
			/** Installed from a Git repository at an exact commit. */
			readonly type: "git";
			/** Canonical `https:` clone URL (equal to its WHATWG serialization). */
			readonly url: string;
			/** Lowercase 40-hex-digit commit SHA. */
			readonly commit: string;
			/** `/`-separated package directory inside the repository; absent = root. */
			readonly path?: string;
	  };

/** One installable version of a listed plugin. */
export interface PluginIndexVersion {
	/** Exact SemVer (no ranges, tags, or `latest`). */
	readonly version: string;
	/** Registry publish time (npm) or committer time (git), Unix seconds. */
	readonly publishedAt: number;
	readonly source: PluginIndexSource;
	/** Host compatibility declared by the plugin manifest. */
	readonly engines: { readonly musepi: string };
}

/** Market-defined plugin metadata. Absent members normalize to empty values. */
export interface PluginIndexEntryMetadata {
	/** One declared category id. */
	readonly category?: string;
	/** Distinct declared label ids. */
	readonly labels: readonly string[];
	/** Free-form keywords; no root declaration required. */
	readonly keywords: readonly string[];
	/** Declared sort-key id → finite number, or `null` when unavailable. */
	readonly sortKeys: Readonly<Record<string, number | null>>;
}

/** One plugin in the index. Display fields describe the plugin, not a version. */
export interface PluginIndexEntry {
	/** Package name, unique within the index. */
	readonly name: string;
	readonly vendor: PluginVendor;
	readonly title?: LocalizedText;
	readonly description?: LocalizedText;
	/** `data:` artwork (≤ 32 KiB decoded) or an absolute `https:` URL. */
	readonly icon?: string;
	/** Short text/emoji stand-in when no artwork is published. */
	readonly glyph?: string;
	readonly author?: string;
	readonly homepage?: string;
	/** Display-only source link; never selects an install source. */
	readonly repository?: { readonly url: string; readonly directory?: string };
	readonly license?: string;
	readonly metadata: PluginIndexEntryMetadata;
	/** Non-empty; array order is display order, not install-version choice. */
	readonly versions: readonly PluginIndexVersion[];
}

/** A parsed, validated `musepi-plugin-index` document. */
export interface PluginIndex {
	readonly format: typeof PLUGIN_INDEX_FORMAT;
	/** Market identifier (also the marketplace name segment used in plugin IDs). */
	readonly name: string;
	readonly title: LocalizedText;
	readonly description?: LocalizedText;
	readonly owner: PluginIndexOwner;
	readonly metadata: PluginIndexDeclarations;
	readonly plugins: readonly PluginIndexEntry[];
}

/** One validation diagnostic, addressed by JSON path from the document root. */
export interface PluginIndexDiagnostic {
	/** JSON path such as `$.plugins[0].versions[1].source.commit`. */
	readonly path: string;
	readonly message: string;
}

export interface PluginIndexAccepted {
	readonly ok: true;
	readonly index: PluginIndex;
	/** Unknown members dropped during validation, each with its JSON path. */
	readonly droppedFields: readonly PluginIndexDiagnostic[];
}

export interface PluginIndexRejected {
	readonly ok: false;
	readonly errors: readonly PluginIndexDiagnostic[];
}

export type PluginIndexParseResult = PluginIndexAccepted | PluginIndexRejected;

// ── Constants ─────────────────────────────────────────────────────────

/** Decoded size limit for an inline `data:` icon (32 KiB). */
export const ICON_MAX_DECODED_BYTES = 32 * 1024;

/** Maximum UTF-16 length accepted for a `glyph` stand-in. */
export const GLYPH_MAX_LENGTH = 32;

const ROOT_FIELDS = new Set(["format", "name", "title", "description", "owner", "metadata", "plugins"]);
const ROOT_METADATA_FIELDS = new Set(["categories", "labels", "sortKeys"]);
const PLUGIN_FIELDS = new Set([
	"name",
	"vendor",
	"title",
	"description",
	"icon",
	"glyph",
	"author",
	"homepage",
	"repository",
	"license",
	"metadata",
	"versions",
]);
const PLUGIN_METADATA_FIELDS = new Set(["category", "labels", "keywords", "sortKeys"]);
const VERSION_FIELDS = new Set(["version", "publishedAt", "source", "engines"]);
const DECLARATION_FIELDS = new Set(["title"]);
const SORT_KEY_FIELDS = new Set(["title", "order"]);
const OWNER_FIELDS = new Set(["name", "email"]);
const REPOSITORY_FIELDS = new Set(["url", "directory"]);
const NPM_SOURCE_FIELDS = new Set(["type", "registry"]);
const GIT_SOURCE_FIELDS = new Set(["type", "url", "commit", "path"]);
const ENGINES_FIELDS = new Set(["musepi"]);

/** npm package-name rule (scoped or unscoped, lowercase for new packages). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Exact SemVer: no range operators, no `v` prefix, no leading zeros, no whitespace. */
const EXACT_VERSION =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Language id for a localized-text map key. */
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;

/** Lowercase 40-hex-digit Git commit SHA. */
const GIT_COMMIT = /^[0-9a-f]{40}$/;

/** One `/`-separated segment of a Git package directory. */
const GIT_PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/** Canonical padded base64 (payload length is a multiple of four). */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const DATA_ICON_TYPES = new Set(["image/svg+xml", "image/png", "image/jpeg", "image/webp"]);

/** Largest accepted `publishedAt` (exclusive): 10^11 Unix seconds. */
const MAX_PUBLISHED_AT = 100_000_000_000;

// The range grammar below mirrors `compat/plugin-compatibility.ts`'s
// `isValidRange`, which is private to that gate. Bun's `satisfies` treats
// garbage as a wildcard instead of failing, so the grammar must be checked
// before any compatibility call. (A shared semver module is a follow-up once
// both call sites are in the same change.)
const RANGE_VERSION = String.raw`(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const RANGE_COMPARATOR = new RegExp(`^(?:\\^|~|>=|<=|>|<|=)?${RANGE_VERSION}$`);
const RANGE_VERSION_ONLY = new RegExp(`^${RANGE_VERSION}$`);

// ── Diagnostics ───────────────────────────────────────────────────────

class Diagnostics {
	readonly errors: PluginIndexDiagnostic[] = [];
	readonly droppedFields: PluginIndexDiagnostic[] = [];

	fail(path: string, message: string): void {
		this.errors.push({ path, message });
	}

	drop(path: string, field: string): void {
		this.droppedFields.push({ path: `${path}.${field}`, message: `unknown field "${field}"` });
	}
}

// ── Primitive readers ─────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Id-keyed map with no prototype chain: declaration ids are market data, so an
 * id such as `__proto__` is an ordinary own property, never the object
 * prototype.
 */
function emptyRecord<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function readObject(value: unknown, path: string, diag: Diagnostics): Record<string, unknown> | undefined {
	if (!isPlainObject(value)) {
		diag.fail(path, value === undefined ? "is required" : "must be an object");
		return undefined;
	}
	return value;
}

function readLocalizedText(
	value: unknown,
	path: string,
	diag: Diagnostics,
	required: boolean,
): LocalizedText | undefined {
	if (value === undefined) {
		if (required) diag.fail(path, "is required");
		return undefined;
	}
	if (typeof value === "string") {
		if (!isNonBlankString(value)) {
			diag.fail(path, "must contain at least one non-whitespace character");
			return undefined;
		}
		return value;
	}
	if (!isPlainObject(value)) {
		diag.fail(path, "must be a string or an object of language-tagged strings");
		return undefined;
	}

	const entries = Object.entries(value);
	if (entries.length === 0) {
		diag.fail(path, "must declare at least one language");
		return undefined;
	}
	const out: Record<string, string> = {};
	let valid = true;
	for (const [language, text] of entries) {
		if (!LANGUAGE_ID.test(language)) {
			diag.fail(`${path}.${language}`, "language id must match ^[a-z]{2,8}(-[a-z0-9]{1,8})*$");
			valid = false;
			continue;
		}
		if (!isNonBlankString(text)) {
			diag.fail(`${path}.${language}`, "must contain at least one non-whitespace character");
			valid = false;
			continue;
		}
		out[language] = text;
	}
	return valid ? out : undefined;
}

function readAbsoluteUrl(
	value: unknown,
	path: string,
	diag: Diagnostics,
	protocols: readonly string[],
	rejectQueryAndFragment = false,
): URL | undefined {
	if (typeof value !== "string" || value === "") {
		diag.fail(path, "must be a non-empty absolute URL");
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		diag.fail(path, `must be an absolute URL, got "${value}"`);
		return undefined;
	}
	if (!protocols.includes(url.protocol)) {
		diag.fail(path, `must use ${protocols.join(" or ")}, got "${url.protocol}"`);
		return undefined;
	}
	if (url.username !== "" || url.password !== "") {
		diag.fail(path, "must not contain credentials");
		return undefined;
	}
	if (rejectQueryAndFragment && (url.search !== "" || url.hash !== "")) {
		diag.fail(path, "must not contain a query or fragment");
		return undefined;
	}
	return url;
}

/** A `/`-separated relative directory: no empty, `.`, or `..` segments. */
export function isSafeRelativeDirectory(value: string): boolean {
	const segments = value.split("/");
	return segments.every(
		segment => segment !== "" && segment !== "." && segment !== ".." && GIT_PATH_SEGMENT.test(segment),
	);
}

/** Canonical `https:` Git clone URL: serialized form, ≥ 2 path segments, no archive suffix. */
function readGitUrl(value: unknown, path: string, diag: Diagnostics): string | undefined {
	const url = readAbsoluteUrl(value, path, diag, ["https:"], true);
	if (!url) return undefined;
	if (url.href !== value) {
		diag.fail(path, `must be the canonical URL serialization, got "${value}" and expected "${url.href}"`);
		return undefined;
	}
	const segments = url.pathname.split("/").filter(segment => segment !== "");
	if (segments.length < 2) {
		diag.fail(path, "must name a repository with at least two path segments");
		return undefined;
	}
	if (url.pathname.endsWith("/") || url.pathname.endsWith(".tgz") || url.pathname.endsWith(".tar.gz")) {
		diag.fail(path, "must not end in a slash, .tgz, or .tar.gz");
		return undefined;
	}
	return value as string;
}

function readPackageName(value: unknown, path: string, diag: Diagnostics): string | undefined {
	if (!isNonBlankString(value)) {
		diag.fail(path, "must be a non-empty package name");
		return undefined;
	}
	if (!PACKAGE_NAME.test(value)) {
		diag.fail(path, `must be a lowercase npm package name, got "${value}"`);
		return undefined;
	}
	return value;
}

function readOptionalString(
	value: unknown,
	path: string,
	diag: Diagnostics,
	options: { maxLength?: number } = {},
): string | undefined {
	if (value === undefined) return undefined;
	if (!isNonBlankString(value)) {
		diag.fail(path, "must contain at least one non-whitespace character");
		return undefined;
	}
	if (options.maxLength !== undefined && value.length > options.maxLength) {
		diag.fail(path, `must be at most ${options.maxLength} UTF-16 code units`);
		return undefined;
	}
	return value;
}

// ── SemVer ────────────────────────────────────────────────────────────

/**
 * Whether `value` is an exact SemVer string usable as an install pin.
 *
 * The regex rejects ranges, tags, `v` prefixes, leading zeros, and
 * whitespace; `Bun.semver.order` self-comparison rejects anything the regex
 * lets through that semver itself refuses. (Same double probe as
 * `compat/compatibility-store.ts` `isExactPluginVersion`.)
 */
export function isExactIndexVersion(value: string): boolean {
	if (!EXACT_VERSION.test(value)) return false;
	try {
		return Bun.semver.order(value, value) === 0;
	} catch {
		return false;
	}
}

/** Whether `range` is a well-formed npm SemVer range (`*` included). */
export function isValidIndexRange(range: string): boolean {
	const trimmed = range.trim();
	if (trimmed === "") return false;
	const normalized = trimmed.replace(/(^|\s)(>=|<=|>|<|=|\^|~)\s+/g, "$1$2");
	return normalized.split("||").every(alternative => {
		const value = alternative.trim();
		if (value === "") return false;
		const hyphen = value.split(/\s+-\s+/);
		if (hyphen.length === 2) return hyphen.every(part => RANGE_VERSION_ONLY.test(part));
		if (hyphen.length !== 1) return false;
		return value.split(/\s+/).every(part => RANGE_COMPARATOR.test(part));
	});
}

/**
 * Whether the host version satisfies a plugin's declared `engines.musepi`
 * range.
 *
 * Bun 1.4.2's `satisfies` has no `includePrerelease` option, so a prerelease
 * runtime is also checked by its base version — the same intent as
 * `compat/plugin-compatibility.ts`. An invalid range is never compatible.
 */
export function isCompatibleWithRuntime(enginesRange: string, runtimeVersion: string): boolean {
	if (!isValidIndexRange(enginesRange)) return false;
	try {
		Bun.semver.order(runtimeVersion, runtimeVersion);
	} catch {
		return false;
	}
	try {
		if (Bun.semver.satisfies(runtimeVersion, enginesRange)) return true;
		const base = runtimeVersion.split("-")[0] ?? runtimeVersion;
		return base !== runtimeVersion && Bun.semver.satisfies(base, enginesRange);
	} catch {
		return false;
	}
}

/**
 * Whether a version carries a prerelease part.
 *
 * Build metadata follows `+` and may contain hyphens while the version stays
 * stable (`1.2.3+build-1`), so only the core before `+` decides.
 */
function isPrerelease(version: string): boolean {
	return (version.split("+")[0] ?? version).includes("-");
}

// ── Root ──────────────────────────────────────────────────────────────

function readOwner(value: unknown, path: string, diag: Diagnostics): PluginIndexOwner | undefined {
	const owner = readObject(value, path, diag);
	if (!owner) return undefined;
	for (const key of Object.keys(owner)) {
		if (!OWNER_FIELDS.has(key)) diag.drop(path, key);
	}
	const name = readOptionalString(owner.name, `${path}.name`, diag);
	const email = readOptionalString(owner.email, `${path}.email`, diag);
	return name === undefined ? undefined : { name, ...(email === undefined ? {} : { email }) };
}

function readDeclarations(value: unknown, path: string, diag: Diagnostics): PluginIndexDeclarations {
	const declarations: {
		categories: Record<string, PluginIndexDeclaration>;
		labels: Record<string, PluginIndexDeclaration>;
		sortKeys: Record<string, PluginIndexSortKeyDeclaration>;
	} = { categories: emptyRecord(), labels: emptyRecord(), sortKeys: emptyRecord() };
	if (value === undefined) return declarations;

	const metadata = readObject(value, path, diag);
	if (!metadata) return declarations;
	for (const key of Object.keys(metadata)) {
		if (!ROOT_METADATA_FIELDS.has(key)) diag.drop(path, key);
	}

	if (metadata.categories !== undefined) {
		declarations.categories = readDeclarationMap(metadata.categories, `${path}.categories`, diag, false);
	}
	if (metadata.labels !== undefined) {
		declarations.labels = readDeclarationMap(metadata.labels, `${path}.labels`, diag, false);
	}
	if (metadata.sortKeys !== undefined) {
		declarations.sortKeys = readDeclarationMap(metadata.sortKeys, `${path}.sortKeys`, diag, true) as Record<
			string,
			PluginIndexSortKeyDeclaration
		>;
	}
	return declarations;
}

function readDeclarationMap<T extends PluginIndexDeclaration | PluginIndexSortKeyDeclaration>(
	value: unknown,
	path: string,
	diag: Diagnostics,
	sortKey: boolean,
): Record<string, T> {
	const map = emptyRecord<T>();
	const obj = readObject(value, path, diag);
	if (!obj) return map;
	for (const [id, raw] of Object.entries(obj)) {
		const entryPath = `${path}.${id}`;
		if (id === "") {
			diag.fail(path, "declaration ids must be non-empty strings");
			continue;
		}
		const entry = readObject(raw, entryPath, diag);
		if (!entry) continue;
		const allowed = sortKey ? SORT_KEY_FIELDS : DECLARATION_FIELDS;
		for (const key of Object.keys(entry)) {
			if (!allowed.has(key)) diag.drop(entryPath, key);
		}
		const title = readLocalizedText(entry.title, `${entryPath}.title`, diag, true);
		if (sortKey) {
			const order = entry.order;
			if (order !== "asc" && order !== "desc") {
				diag.fail(`${entryPath}.order`, 'must be "asc" or "desc"');
				continue;
			}
			if (title !== undefined) map[id] = { title, order } as T;
		} else if (title !== undefined) {
			map[id] = { title } as T;
		}
	}
	return map;
}

// ── Plugin ────────────────────────────────────────────────────────────

function readPlugins(
	value: unknown,
	path: string,
	diag: Diagnostics,
	declarations: PluginIndexDeclarations,
): PluginIndexEntry[] | undefined {
	if (value === undefined) {
		diag.fail(path, "is required");
		return undefined;
	}
	if (!Array.isArray(value)) {
		diag.fail(path, "must be an array");
		return undefined;
	}

	const entries: PluginIndexEntry[] = [];
	const seen = new Map<string, number>();
	for (let i = 0; i < value.length; i++) {
		const entry = readPlugin(value[i], `${path}[${i}]`, diag, declarations);
		if (entry === undefined) continue;
		const previous = seen.get(entry.name);
		if (previous !== undefined) {
			diag.fail(
				`${path}[${i}].name`,
				`duplicates plugins[${previous}].name "${entry.name}"; names are unique within an index`,
			);
		} else {
			seen.set(entry.name, i);
		}
		entries.push(entry);
	}
	return entries;
}

function readVendor(value: unknown, path: string, diag: Diagnostics): PluginVendor | undefined {
	if (value === "musepi" || value === "pi" || value === "claude" || value === "codex") return value;
	diag.fail(
		path,
		'must be "musepi" (native), "pi" (omp/pi manifest), "claude" (.claude-plugin), or "codex" (.codex-plugin)',
	);
	return undefined;
}

function readIcon(value: unknown, path: string, diag: Diagnostics): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") {
		diag.fail(path, "must be a non-empty string");
		return undefined;
	}

	if (value.startsWith("data:")) {
		const comma = value.indexOf(",");
		if (comma < 0) {
			diag.fail(path, 'must be "data:<type>;base64,<payload>"');
			return undefined;
		}
		const meta = value.slice("data:".length, comma).split(";");
		const [mediaType, encoding] = meta;
		if (mediaType === undefined || !DATA_ICON_TYPES.has(mediaType) || encoding !== "base64") {
			diag.fail(
				path,
				`must be base64 data of type ${[...DATA_ICON_TYPES].join(", ")} (for example "data:image/svg+xml;base64,...")`,
			);
			return undefined;
		}
		const payload = value.slice(comma + 1);
		if (!BASE64.test(payload)) {
			diag.fail(path, "payload must be canonical padded base64");
			return undefined;
		}
		const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
		const decodedBytes = (payload.length / 4) * 3 - padding;
		if (decodedBytes > ICON_MAX_DECODED_BYTES) {
			diag.fail(path, `decoded icon is ${decodedBytes} bytes; the inline limit is ${ICON_MAX_DECODED_BYTES} bytes`);
			return undefined;
		}
		if (Buffer.from(payload, "base64").toString("base64") !== payload) {
			diag.fail(path, "payload must be canonical padded base64");
			return undefined;
		}
		return value;
	}

	const url = readAbsoluteUrl(value, path, diag, ["https:"]);
	return url === undefined ? undefined : value;
}

function readRepository(
	value: unknown,
	path: string,
	diag: Diagnostics,
): { url: string; directory?: string } | undefined {
	const repository = readObject(value, path, diag);
	if (!repository) return undefined;
	for (const key of Object.keys(repository)) {
		if (!REPOSITORY_FIELDS.has(key)) diag.drop(path, key);
	}
	const urlValue = readAbsoluteUrl(repository.url, `${path}.url`, diag, ["http:", "https:"], true);
	const directory =
		repository.directory === undefined
			? undefined
			: readSafeDirectory(repository.directory, `${path}.directory`, diag);
	if (urlValue === undefined) return undefined;
	return directory === undefined ? { url: urlValue.href } : { url: urlValue.href, directory };
}

/** A safe relative directory, rejecting traversal and absolute forms. */
function readSafeDirectory(value: unknown, path: string, diag: Diagnostics): string | undefined {
	if (typeof value !== "string" || value === "") {
		diag.fail(path, "must be a non-empty relative directory");
		return undefined;
	}
	if (value.startsWith("/") || value.startsWith("\\") || !isSafeRelativeDirectory(value)) {
		diag.fail(
			path,
			`must be a relative directory using segments of [A-Za-z0-9._@+-], without "." or "..", got "${value}"`,
		);
		return undefined;
	}
	return value;
}

function readPluginMetadata(
	value: unknown,
	path: string,
	diag: Diagnostics,
	declarations: PluginIndexDeclarations,
): PluginIndexEntryMetadata {
	const normalized: {
		category?: string;
		labels: string[];
		keywords: string[];
		sortKeys: Record<string, number | null>;
	} = { labels: [], keywords: [], sortKeys: emptyRecord() };
	if (value === undefined) return normalized;

	const metadata = readObject(value, path, diag);
	if (!metadata) return normalized;
	for (const key of Object.keys(metadata)) {
		if (!PLUGIN_METADATA_FIELDS.has(key)) diag.drop(path, key);
	}

	if (metadata.category !== undefined) {
		if (!isNonBlankString(metadata.category)) {
			diag.fail(`${path}.category`, "must be a declared category id");
		} else if (!Object.hasOwn(declarations.categories, metadata.category)) {
			diag.fail(`${path}.category`, `"${metadata.category}" is not declared under $.metadata.categories`);
		} else {
			normalized.category = metadata.category;
		}
	}

	if (metadata.labels !== undefined) {
		normalized.labels = readDeclaredIds(metadata.labels, `${path}.labels`, diag, declarations.labels, "label");
	}

	if (metadata.keywords !== undefined) {
		if (!Array.isArray(metadata.keywords)) {
			diag.fail(`${path}.keywords`, "must be an array of strings");
		} else {
			for (let i = 0; i < metadata.keywords.length; i++) {
				const keyword = metadata.keywords[i];
				if (typeof keyword !== "string") {
					diag.fail(`${path}.keywords[${i}]`, "must be a string");
					continue;
				}
				normalized.keywords.push(keyword);
			}
		}
	}

	if (metadata.sortKeys !== undefined) {
		const values = readObject(metadata.sortKeys, `${path}.sortKeys`, diag);
		if (values) {
			for (const [id, raw] of Object.entries(values)) {
				const valuePath = `${path}.sortKeys.${id}`;
				if (!Object.hasOwn(declarations.sortKeys, id)) {
					diag.fail(valuePath, `"${id}" is not declared under $.metadata.sortKeys`);
					continue;
				}
				if (raw === null) {
					normalized.sortKeys[id] = null;
				} else if (typeof raw === "number" && Number.isFinite(raw)) {
					normalized.sortKeys[id] = raw;
				} else {
					diag.fail(valuePath, "must be a finite number or null");
				}
			}
		}
	}

	return normalized;
}

function readDeclaredIds(
	value: unknown,
	path: string,
	diag: Diagnostics,
	declared: Readonly<Record<string, unknown>>,
	kind: string,
): string[] {
	if (!Array.isArray(value)) {
		diag.fail(path, `must be an array of declared ${kind} ids`);
		return [];
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < value.length; i++) {
		const id = value[i];
		const idPath = `${path}[${i}]`;
		if (!isNonBlankString(id)) {
			diag.fail(idPath, `must be a declared ${kind} id`);
			continue;
		}
		if (!Object.hasOwn(declared, id)) {
			diag.fail(idPath, `"${id}" is not declared under $.metadata.${kind}s`);
			continue;
		}
		if (seen.has(id)) {
			diag.fail(idPath, `duplicates "${id}"`);
			continue;
		}
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function readPlugin(
	value: unknown,
	path: string,
	diag: Diagnostics,
	declarations: PluginIndexDeclarations,
): PluginIndexEntry | undefined {
	const plugin = readObject(value, path, diag);
	if (!plugin) return undefined;
	for (const key of Object.keys(plugin)) {
		if (!PLUGIN_FIELDS.has(key)) diag.drop(path, key);
	}

	const name = readPackageName(plugin.name, `${path}.name`, diag);
	const vendor = readVendor(plugin.vendor, `${path}.vendor`, diag);
	const title = readLocalizedText(plugin.title, `${path}.title`, diag, false);
	const description = readLocalizedText(plugin.description, `${path}.description`, diag, false);
	const icon = readIcon(plugin.icon, `${path}.icon`, diag);
	const glyph = readOptionalString(plugin.glyph, `${path}.glyph`, diag, { maxLength: GLYPH_MAX_LENGTH });
	const author = readOptionalString(plugin.author, `${path}.author`, diag);
	const homepage =
		plugin.homepage === undefined
			? undefined
			: readAbsoluteUrl(plugin.homepage, `${path}.homepage`, diag, ["http:", "https:"]);
	const repository =
		plugin.repository === undefined ? undefined : readRepository(plugin.repository, `${path}.repository`, diag);
	const license = readOptionalString(plugin.license, `${path}.license`, diag);
	const metadata = readPluginMetadata(plugin.metadata, `${path}.metadata`, diag, declarations);
	const versions = readVersions(plugin.versions, `${path}.versions`, diag);

	return {
		name: name ?? "",
		vendor: vendor ?? "musepi",
		...(title === undefined ? {} : { title }),
		...(description === undefined ? {} : { description }),
		...(icon === undefined ? {} : { icon }),
		...(glyph === undefined ? {} : { glyph }),
		...(author === undefined ? {} : { author }),
		...(homepage === undefined ? {} : { homepage: homepage.href }),
		...(repository === undefined ? {} : { repository }),
		...(license === undefined ? {} : { license }),
		metadata,
		versions: versions ?? [],
	};
}

// ── Version ───────────────────────────────────────────────────────────

function readVersions(value: unknown, path: string, diag: Diagnostics): PluginIndexVersion[] | undefined {
	if (value === undefined) {
		diag.fail(path, "is required");
		return undefined;
	}
	if (!Array.isArray(value)) {
		diag.fail(path, "must be an array");
		return undefined;
	}
	if (value.length === 0) {
		diag.fail(path, "must list at least one version");
		return undefined;
	}

	const versions: PluginIndexVersion[] = [];
	const seen = new Map<string, number>();
	for (let i = 0; i < value.length; i++) {
		const version = readVersion(value[i], `${path}[${i}]`, diag);
		if (version === undefined) continue;
		const previous = seen.get(version.version);
		if (previous !== undefined) {
			diag.fail(`${path}[${i}].version`, `duplicates versions[${previous}] "${version.version}"`);
		} else {
			seen.set(version.version, i);
		}
		versions.push(version);
	}
	return versions;
}

function readVersion(value: unknown, path: string, diag: Diagnostics): PluginIndexVersion | undefined {
	const version = readObject(value, path, diag);
	if (!version) return undefined;
	for (const key of Object.keys(version)) {
		if (!VERSION_FIELDS.has(key)) diag.drop(path, key);
	}

	const versionValue = version.version;
	let exact: string | undefined;
	if (typeof versionValue !== "string" || !isExactIndexVersion(versionValue)) {
		diag.fail(
			`${path}.version`,
			`must be an exact SemVer version (no ranges, tags, or "latest"), got ${JSON.stringify(versionValue)}`,
		);
	} else {
		exact = versionValue;
	}

	const publishedAt = version.publishedAt;
	const publishedAtValid =
		typeof publishedAt === "number" &&
		Number.isInteger(publishedAt) &&
		publishedAt >= 0 &&
		publishedAt < MAX_PUBLISHED_AT;
	if (!publishedAtValid) {
		diag.fail(`${path}.publishedAt`, "must be an integer Unix timestamp in seconds in [0, 10^11)");
	}

	const source = readSource(version.source, `${path}.source`, diag);
	const engines = readEngines(version.engines, `${path}.engines`, diag);

	if (exact === undefined || !publishedAtValid || source === undefined || engines === undefined) return undefined;
	return { version: exact, publishedAt: publishedAt as number, source, engines };
}

function readEngines(value: unknown, path: string, diag: Diagnostics): { musepi: string } | undefined {
	const engines = readObject(value, path, diag);
	if (!engines) return undefined;
	for (const key of Object.keys(engines)) {
		if (!ENGINES_FIELDS.has(key)) diag.drop(path, key);
	}
	const musepi = engines.musepi;
	if (!isNonBlankString(musepi)) {
		diag.fail(`${path}.musepi`, "must declare the npm SemVer range the plugin supports");
		return undefined;
	}
	if (!isValidIndexRange(musepi)) {
		diag.fail(`${path}.musepi`, `must be a valid npm SemVer range, got "${musepi}"`);
		return undefined;
	}
	return { musepi };
}

function readSource(value: unknown, path: string, diag: Diagnostics): PluginIndexSource | undefined {
	const source = readObject(value, path, diag);
	if (!source) return undefined;

	switch (source.type) {
		case "npm": {
			for (const key of Object.keys(source)) {
				if (!NPM_SOURCE_FIELDS.has(key)) diag.drop(path, key);
			}
			if (source.registry === undefined) return { type: "npm" };
			const registry = readAbsoluteUrl(source.registry, `${path}.registry`, diag, ["http:", "https:"], true);
			return registry === undefined ? undefined : { type: "npm", registry: registry.href };
		}
		case "git": {
			for (const key of Object.keys(source)) {
				if (!GIT_SOURCE_FIELDS.has(key)) diag.drop(path, key);
			}
			const url = readGitUrl(source.url, `${path}.url`, diag);
			const commit = source.commit;
			if (typeof commit !== "string" || !GIT_COMMIT.test(commit)) {
				diag.fail(`${path}.commit`, "must be a lowercase 40-hex-digit commit SHA");
			}
			const sourcePath =
				source.path === undefined ? undefined : readSafeDirectory(source.path, `${path}.path`, diag);
			if (url === undefined || typeof commit !== "string" || !GIT_COMMIT.test(commit)) return undefined;
			return sourcePath === undefined
				? { type: "git", url, commit }
				: { type: "git", url, commit, path: sourcePath };
		}
		default:
			diag.fail(`${path}.type`, 'must be "npm" or "git"; an unknown source type is not an installable pin');
			return undefined;
	}
}

// ── Entry points ──────────────────────────────────────────────────────

/**
 * Validate a parsed JSON value as a `musepi-plugin-index` document.
 *
 * Collects every diagnostic before returning, so one reader pass reports all
 * defects instead of the first one. Unknown members are dropped and listed in
 * `droppedFields`; a rejected index lists all errors with JSON paths.
 */
export function parsePluginIndex(raw: unknown): PluginIndexParseResult {
	const diag = new Diagnostics();
	const format = isPlainObject(raw) ? raw.format : undefined;
	if (format !== PLUGIN_INDEX_FORMAT) {
		diag.fail(
			"$.format",
			format === undefined
				? `is required and must be the integer ${PLUGIN_INDEX_FORMAT}`
				: `must be the integer ${PLUGIN_INDEX_FORMAT}; got ${JSON.stringify(format)}`,
		);
	}

	const root = readObject(raw, "$", diag);
	if (root === undefined) return { ok: false, errors: diag.errors };

	for (const key of Object.keys(root)) {
		if (!ROOT_FIELDS.has(key)) diag.drop("$", key);
	}

	const name = readMarketName(root.name, "$.name", diag);
	const title = readLocalizedText(root.title, "$.title", diag, true);
	const description = readLocalizedText(root.description, "$.description", diag, false);
	const owner = readOwner(root.owner, "$.owner", diag);
	const metadata = readDeclarations(root.metadata, "$.metadata", diag);
	const plugins = readPlugins(root.plugins, "$.plugins", diag, metadata);

	if (
		diag.errors.length > 0 ||
		name === undefined ||
		title === undefined ||
		owner === undefined ||
		plugins === undefined
	) {
		return { ok: false, errors: diag.errors.length > 0 ? diag.errors : [{ path: "$", message: "index is invalid" }] };
	}

	return {
		ok: true,
		index: {
			format: PLUGIN_INDEX_FORMAT,
			name,
			title,
			...(description === undefined ? {} : { description }),
			owner,
			metadata,
			plugins,
		},
		droppedFields: diag.droppedFields,
	};
}

/** Parse JSON text, then validate it as a plugin index. */
export function parsePluginIndexJson(text: string): PluginIndexParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		return {
			ok: false,
			errors: [{ path: "$", message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }],
		};
	}
	return parsePluginIndex(raw);
}

function readMarketName(value: unknown, path: string, diag: Diagnostics): string | undefined {
	if (value === undefined) {
		diag.fail(path, "is required");
		return undefined;
	}
	if (!isNonBlankString(value) || !isValidNameSegment(value)) {
		diag.fail(path, "must be a lowercase name segment (letters, digits, hyphens, dots; max 64)");
		return undefined;
	}
	return value;
}

// ── Host decisions: version choice and install spec ───────────────────

/**
 * The version the host installs when the person does not pick one.
 *
 * Highest compatible stable version; when no stable version is compatible, the
 * highest compatible prerelease. `undefined` means the market lists nothing
 * this host can run — there is deliberately no npm `latest` fallback, because
 * an unpublished tag must never decide what an index entry installs.
 */
export function selectDefaultVersion(plugin: PluginIndexEntry, runtimeVersion: string): PluginIndexVersion | undefined {
	let bestStable: PluginIndexVersion | undefined;
	let bestPrerelease: PluginIndexVersion | undefined;
	for (const version of plugin.versions) {
		if (!isCompatibleWithRuntime(version.engines.musepi, runtimeVersion)) continue;
		const current = isPrerelease(version.version) ? bestPrerelease : bestStable;
		if (current === undefined || Bun.semver.order(version.version, current.version) > 0) {
			if (isPrerelease(version.version)) bestPrerelease = version;
			else bestStable = version;
		}
	}
	return bestStable ?? bestPrerelease;
}

/** Installer arguments the host derives from one validated index version. */
export interface PluginInstallTarget {
	/** Exact installer spec: `name@version` (npm) or `git+<url>#<commit>[&path:/<dir>]` (git). */
	readonly spec: string;
	/** npm only: the registry this version names; apply it to this install only. */
	readonly registry?: string;
}

/**
 * Build the installer argument for one index version.
 *
 * The index has no free-form install field: the host composes the spec from
 * the exact version and the structured source, so a reader can verify that the
 * spec is pinned to what the list displayed. A named npm registry travels
 * beside the spec because the spec grammar has no registry slot; a git package
 * directory rides in the fragment.
 *
 * Re-validates the source with the same rules as the parser (canonical git URL
 * with at least two path segments and no archive suffix, safe package path,
 * credential-free registry), so a direct caller gets the same refusal instead
 * of a weaker spec. This makes the helper safe on its own; parsing an index is
 * still the trust boundary for the market.
 */
export function installSpec(name: string, version: string, source: PluginIndexSource): PluginInstallTarget {
	if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid plugin package name: "${name}"`);
	if (!isExactIndexVersion(version)) throw new Error(`Invalid exact plugin version: "${version}"`);

	if (source.type === "npm") {
		if (source.registry === undefined) return { spec: `${name}@${version}` };
		const registry = readAbsoluteUrl(
			source.registry,
			"source.registry",
			new Diagnostics(),
			["http:", "https:"],
			true,
		);
		if (registry === undefined) throw new Error(`Invalid npm registry URL: "${source.registry}"`);
		return { spec: `${name}@${version}`, registry: registry.href };
	}

	if (!GIT_COMMIT.test(source.commit))
		throw new Error(`Invalid Git commit for ${name}@${version}: "${source.commit}"`);
	const diagnostics = new Diagnostics();
	const url = readGitUrl(source.url, "source.url", diagnostics);
	if (url === undefined) {
		const reason = diagnostics.errors.map(error => error.message).join("; ");
		throw new Error(`Invalid Git source URL for ${name}@${version}: ${reason}`);
	}
	if (source.path !== undefined && !isSafeRelativeDirectory(source.path)) {
		throw new Error(`Invalid Git package directory: "${source.path}"`);
	}

	const cloneUrl = url.endsWith(".git") ? url : `${url}.git`;
	const pin = source.path === undefined ? source.commit : `${source.commit}&path:/${source.path}`;
	return { spec: `git+${cloneUrl}#${pin}` };
}
