/**
 * Connector catalog loader.
 *
 * Three sources, highest precedence first:
 *
 * 1. An explicit index from `MUSEPI_CONNECTOR_CATALOG` (a JSON file or URL).
 * 2. `<agentDir>/connectors/catalog.json`.
 * 3. WorkBuddy-compatible package directories under
 *    `<agentDir>/connectors/marketplace/<id>/` (`plugin.json` + `mcp.json`).
 *
 * Index entries win over package entries with the same id. Only remote
 * `http`/`sse` servers are accepted; a package that declares a command is a
 * CLI/stdio connector and belongs to the install layer, not this catalog.
 *
 * Remote indexes are fetched per refresh, bounded by a 10s timeout, and never
 * cached across processes. An unreachable source degrades to the remaining
 * sources with a warning instead of failing the whole catalog.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@musepi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { BUNDLED_CONNECTORS } from "./bundled-catalog";
import { connectorCustomPath, readCustomEntries } from "./import";
import {
	CONNECTOR_DIR_NAME,
	CONNECTOR_ID_PATTERN,
	CONNECTOR_INDEX_FILE,
	type ConnectorAuthMode,
	type ConnectorCatalogEntry,
	type ConnectorCliSpec,
	type ConnectorOAuthSpec,
	type ConnectorPlatform,
	type ConnectorPlatformCommand,
	type ConnectorServerSpec,
	type ConnectorStdioServerSpec,
	type ConnectorTokenField,
	type ConnectorTokenSchema,
} from "./types";

const CATALOG_CACHE_TTL_MS = 5_000;
const REMOTE_FETCH_TIMEOUT_MS = 10_000;

/**
 * The index the app checks on its own.
 *
 * The bundled catalog ships with the app and works offline; this index only
 * overrides it, which is how a broken endpoint or a new service reaches users
 * between releases. A user index, a connector package or an explicit
 * `MUSEPI_CONNECTOR_CATALOG` all still win over it.
 */
const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/MuseLinn/MusePi/main/connectors/catalog.json";

/** How long a fetched index is trusted before it is revalidated. */
const INDEX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Where the fetched index is kept between runs, per URL. */
const INDEX_CACHE_DIR_NAME = "index-cache";
const MAX_EXAMPLES = 5;
const MAX_TEXT_LENGTH = 2_000;

/** Headers that carry a credential belong in auth storage, never in a catalog. */
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"api-key",
	"x-auth-token",
]);

export interface ConnectorCatalogResult {
	entries: ConnectorCatalogEntry[];
	warnings: string[];
}

export interface LoadConnectorCatalogOptions {
	agentDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Bypass the short-lived process cache. */
	refresh?: boolean;
}

interface CatalogCacheEntry extends ConnectorCatalogResult {
	key: string;
	at: number;
}

let cache: CatalogCacheEntry | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
	return trimmed;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		const text = readString(item, 300);
		if (text) out.push(text);
		if (out.length >= MAX_EXAMPLES) break;
	}
	return out.length > 0 ? out : undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function parseStdioSpec(raw: Record<string, unknown>): ConnectorStdioServerSpec | undefined {
	const command = readString(raw.command, 2_048);
	if (!command || /[\x00-\x1f\x7f]/.test(command)) return undefined;
	const spec: ConnectorStdioServerSpec = { type: "stdio", command };
	if (Array.isArray(raw.args)) {
		const args: string[] = [];
		for (const value of raw.args) {
			const text = typeof value === "string" ? value : undefined;
			if (text === undefined || text.length > 4_096 || /[\x00\x7f]/.test(text)) return undefined;
			args.push(text);
			if (args.length >= 128) break;
		}
		if (args.length > 0) spec.args = args;
	}
	if (isRecord(raw.env)) {
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(raw.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
			if (typeof value !== "string" || /[\x00]/.test(value) || value.length > 4_096) return undefined;
			env[name] = value;
			if (Object.keys(env).length >= 64) break;
		}
		if (Object.keys(env).length > 0) spec.env = env;
	}
	const cwd = readString(raw.cwd, 2_048);
	if (cwd) spec.cwd = cwd;
	return spec;
}

function parsePlatformCommand(raw: unknown): ConnectorPlatformCommand | undefined {
	if (typeof raw === "string") {
		const command = readString(raw, 4_096);
		return command ? { darwin: command, linux: command, win32: command } : undefined;
	}
	if (!isRecord(raw)) return undefined;
	const commands: ConnectorPlatformCommand = {};
	for (const platform of ["darwin", "linux", "win32"] as const satisfies readonly ConnectorPlatform[]) {
		const value = readString(raw[platform], 4_096);
		if (value) commands[platform] = value;
	}
	return Object.keys(commands).length > 0 ? commands : undefined;
}

function parseCliSpec(raw: unknown, warnings: string[], source: string): ConnectorCliSpec | undefined {
	if (!isRecord(raw)) return undefined;
	const spec: ConnectorCliSpec = {};
	if (isRecord(raw.runtime)) {
		const type = readString(raw.runtime.type, 32);
		if (!type) return undefined;
		spec.runtime = {
			type,
			...(readString(raw.runtime.version, 64) ? { version: readString(raw.runtime.version, 64) } : {}),
		};
	}
	const init = parsePlatformCommand(raw.init);
	if (init) spec.init = init;
	if (isRecord(raw.versionCheck)) {
		const command = parsePlatformCommand(raw.versionCheck.command);
		const minVersion = readString(raw.versionCheck.minVersion, 64);
		if (command || minVersion)
			spec.versionCheck = { ...(command ? { command } : {}), ...(minVersion ? { minVersion } : {}) };
	}
	const auth = parsePlatformCommand(raw.auth);
	if (auth) spec.auth = auth;
	const unAuth = parsePlatformCommand(raw.unAuth);
	if (unAuth) spec.unAuth = unAuth;
	const status = parsePlatformCommand(raw.status);
	if (status) spec.status = status;
	const statusMatch = readString(raw.statusMatch, 128);
	if (statusMatch) spec.statusMatch = statusMatch;
	const authUrlDomain = readString(raw.authUrlDomain, 256);
	if (authUrlDomain) spec.authUrlDomain = authUrlDomain;
	if (!spec.init && !spec.auth) {
		warnings.push(`${source}: CLI connector has neither init nor auth commands`);
		return undefined;
	}
	return spec;
}

function parseServerSpec(raw: unknown, warnings?: string[]): ConnectorServerSpec | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.command === "string" && raw.command.trim().length > 0) {
		// A catalog-declared command executes local code; the service requires
		// an explicit per-fingerprint approval before it is mounted.
		return parseStdioSpec(raw);
	}
	const url = readString(raw.url, 2_048);
	if (!url || !isHttpUrl(url)) return undefined;
	const type = raw.type === "sse" ? "sse" : raw.type === "http" ? "http" : url.endsWith("/sse") ? "sse" : "http";
	const spec: ConnectorServerSpec = { type, url };
	if (isRecord(raw.headers)) {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(raw.headers)) {
			if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
				warnings?.push(`connector ${url}: static credential header "${name}" ignored; use auth instead`);
				continue;
			}
			const text = readString(value, 4_096);
			if (text && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) headers[name] = text;
		}
		if (Object.keys(headers).length > 0) spec.headers = headers;
	}
	return spec;
}

function parseAuthMode(raw: unknown): ConnectorAuthMode {
	if (raw === "none") return "none";
	if (raw === "token") return "token";
	return "oauth";
}

function parseTokenField(raw: unknown): ConnectorTokenField | undefined {
	if (!isRecord(raw)) return undefined;
	const key = readString(raw.key, 64);
	if (!key || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return undefined;
	const label = readString(raw.label, 128) ?? key;
	const type = raw.type === "text" ? "text" : "password";
	const field: ConnectorTokenField = { key, label, type };
	if (raw.required === true) field.required = true;
	const placeholder = readString(raw.placeholder, 256);
	if (placeholder) field.placeholder = placeholder;
	const description = readString(raw.description, 500);
	if (description) field.description = description;
	return field;
}

function parseTokenSchema(raw: unknown, warnings: string[], source: string): ConnectorTokenSchema | undefined {
	if (!isRecord(raw)) return undefined;
	if (!Array.isArray(raw.fields)) {
		warnings.push(`${source}: token schema has no fields`);
		return undefined;
	}
	const fields: ConnectorTokenField[] = [];
	for (const field of raw.fields) {
		const parsed = parseTokenField(field);
		if (parsed) fields.push(parsed);
		if (fields.length >= 20) break;
	}
	// A schema may carry only a pasted token or only an OAuth client, with no
	// ordinary field among them; the fields list is then legitimately empty,
	// and the schema is judged by what it does declare.
	const declaresCredential = isRecord(raw.personalAccessToken) || isRecord(raw.oauthClient);
	if (fields.length === 0 && !declaresCredential) {
		warnings.push(`${source}: token schema has no valid fields`);
		return undefined;
	}
	const schema: ConnectorTokenSchema = { fields };
	const title = readString(raw.title, 128);
	if (title) schema.title = title;
	const description = readString(raw.description, 500);
	if (description) schema.description = description;
	const docUrl = readString(raw.docUrl, 2_048);
	if (docUrl && isHttpUrl(docUrl)) schema.docUrl = docUrl;
	if (isRecord(raw.header)) {
		const name = readString(raw.header.name, 64);
		const template = readString(raw.header.template, 256);
		if (name && template && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
			schema.header = { name, template };
		} else {
			warnings.push(`${source}: token header must have a valid name and template`);
		}
	}
	if (isRecord(raw.oauthClient)) {
		const clientIdField = readString(raw.oauthClient.clientIdField, 64);
		const clientSecretField = readString(raw.oauthClient.clientSecretField, 64);
		if (clientIdField && clientSecretField) {
			schema.oauthClient = { clientIdField, clientSecretField };
		} else {
			warnings.push(`${source}: oauth client needs a client id field and a client secret field`);
		}
	}
	if (isRecord(raw.personalAccessToken)) {
		const field = readString(raw.personalAccessToken.field, 64);
		if (field && /^[A-Za-z0-9_.-]{1,64}$/.test(field)) {
			const pat: NonNullable<ConnectorTokenSchema["personalAccessToken"]> = { field };
			const label = readString(raw.personalAccessToken.label, 128);
			if (label) pat.label = label;
			const docUrl = readString(raw.personalAccessToken.docUrl, 2_048);
			if (docUrl && isHttpUrl(docUrl)) pat.docUrl = docUrl;
			schema.personalAccessToken = pat;
		} else {
			warnings.push(`${source}: personal access token needs a plain field name`);
		}
	}
	if (raw.query !== undefined) {
		const query = readString(raw.query, 64);
		if (query && /^[A-Za-z0-9_.-]{1,64}$/.test(query)) {
			if (schema.header) {
				warnings.push(`${source}: token schema declares both header and query; keeping header`);
			} else {
				schema.query = query;
			}
		} else {
			warnings.push(`${source}: token query parameter must be a plain name`);
		}
	}
	return schema;
}

function parseOAuthSpec(raw: unknown): ConnectorOAuthSpec | undefined {
	if (!isRecord(raw)) return undefined;
	const spec: ConnectorOAuthSpec = {};
	const clientId = readString(raw.clientId, 512);
	if (clientId) spec.clientId = clientId;
	const clientSecret = readString(raw.clientSecret, 512);
	if (clientSecret) spec.clientSecret = clientSecret;
	const authorizationUrl = readString(raw.authorizationUrl, 2_048);
	if (authorizationUrl && isHttpUrl(authorizationUrl)) spec.authorizationUrl = authorizationUrl;
	const tokenUrl = readString(raw.tokenUrl, 2_048);
	if (tokenUrl && isHttpUrl(tokenUrl)) spec.tokenUrl = tokenUrl;
	const deviceAuthorizationUrl = readString(raw.deviceAuthorizationUrl, 2_048);
	if (deviceAuthorizationUrl && isHttpUrl(deviceAuthorizationUrl))
		spec.deviceAuthorizationUrl = deviceAuthorizationUrl;
	const scopes = readString(raw.scopes, 1_024);
	if (scopes) spec.scopes = scopes;
	if (typeof raw.callbackPort === "number" && Number.isInteger(raw.callbackPort) && raw.callbackPort > 0) {
		spec.callbackPort = raw.callbackPort;
	}
	const callbackPath = readString(raw.callbackPath, 256);
	if (callbackPath?.startsWith("/")) spec.callbackPath = callbackPath;
	return Object.keys(spec).length > 0 ? spec : undefined;
}

function parseCatalogEntry(
	raw: unknown,
	source: string,
	sourceKind: ConnectorCatalogEntry["sourceKind"],
	warnings: string[],
): ConnectorCatalogEntry | undefined {
	if (!isRecord(raw)) {
		warnings.push(`${source}: connector entry is not an object`);
		return undefined;
	}
	const id = readString(raw.id, 64);
	if (!id || !CONNECTOR_ID_PATTERN.test(id)) {
		warnings.push(`${source}: invalid connector id ${JSON.stringify(raw.id)}`);
		return undefined;
	}
	const server = parseServerSpec(raw.server, warnings);
	const cli = parseCliSpec(raw.cli, warnings, `${source}: connector "${id}"`);
	if (!server && !cli) {
		warnings.push(`${source}: connector "${id}" has no valid server or CLI spec`);
		return undefined;
	}
	const name = readString(raw.name, 128) ?? id;
	const description = readString(raw.description) ?? "";
	const authMode = parseAuthMode(isRecord(raw.auth) ? raw.auth.mode : undefined);
	const tokenSchema = parseTokenSchema(raw.tokenSchema, warnings, `${source}: connector "${id}"`);
	if (authMode === "token" && !tokenSchema) {
		warnings.push(`${source}: token connector "${id}" has no token schema`);
		return undefined;
	}
	const entry: ConnectorCatalogEntry = {
		id,
		name,
		description,
		...(server ? { server } : {}),
		...(cli ? { cli } : {}),
		auth: { mode: cli && !server ? "none" : authMode },
		source,
		sourceKind,
	};
	const descriptionZh = readString(raw.descriptionZh, MAX_TEXT_LENGTH);
	if (descriptionZh) entry.descriptionZh = descriptionZh;
	const details = readString(raw.details, MAX_TEXT_LENGTH);
	if (details) entry.details = details;
	const detailsZh = readString(raw.detailsZh, MAX_TEXT_LENGTH);
	if (detailsZh) entry.detailsZh = detailsZh;
	if (raw.featured === true) entry.featured = true;
	if (
		raw.verified === "oauth" ||
		raw.verified === "none" ||
		raw.verified === "token" ||
		raw.verified === "needs-app"
	) {
		entry.verified = raw.verified;
	}
	if (tokenSchema) entry.tokenSchema = tokenSchema;
	const category = readString(raw.category, 64);
	if (category) entry.category = category;
	const icon = readString(raw.icon, 2_048);
	if (icon) entry.icon = icon;
	const docsUrl = readString(raw.docsUrl, 2_048);
	if (docsUrl && isHttpUrl(docsUrl)) entry.docsUrl = docsUrl;
	const version = readString(raw.version, 64);
	if (version) entry.version = version;
	const examples = readStringArray(raw.examples);
	if (examples) entry.examples = examples;
	const examplesZh = readStringArray(raw.examplesZh);
	if (examplesZh) entry.examplesZh = examplesZh;
	const oauth = parseOAuthSpec(raw.oauth);
	if (oauth) entry.oauth = oauth;
	return entry;
}

function parseIndex(
	data: unknown,
	source: string,
	sourceKind: "index" | "remote",
	warnings: string[],
): ConnectorCatalogEntry[] {
	if (!isRecord(data)) {
		warnings.push(`${source}: catalog root is not an object`);
		return [];
	}
	if (data.version !== undefined && data.version !== 1) {
		warnings.push(`${source}: unsupported catalog version ${JSON.stringify(data.version)}`);
		return [];
	}
	if (!Array.isArray(data.connectors)) {
		warnings.push(`${source}: catalog has no "connectors" array`);
		return [];
	}
	const entries: ConnectorCatalogEntry[] = [];
	for (const raw of data.connectors) {
		const entry = parseCatalogEntry(raw, source, sourceKind, warnings);
		if (entry) entries.push(entry);
	}
	return entries;
}

async function readIndexFile(filePath: string, warnings: string[]): Promise<ConnectorCatalogEntry[]> {
	let text: string;
	try {
		text = await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return [];
	}
	try {
		return parseIndex(JSON.parse(text), filePath, "index", warnings);
	} catch (error) {
		warnings.push(`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		return [];
	}
}

interface IndexCacheFile {
	url: string;
	fetchedAt: number;
	etag?: string;
	/** The index body exactly as served, so a later read needs no network. */
	data: unknown;
}

function indexCachePath(agentDir: string, url: string): string {
	const name = Bun.hash(url).toString(36);
	return path.join(agentDir, CONNECTOR_DIR_NAME, INDEX_CACHE_DIR_NAME, `${name}.json`);
}

async function readIndexCache(agentDir: string, url: string): Promise<IndexCacheFile | undefined> {
	const filePath = indexCachePath(agentDir, url);
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
		if (!isRecord(parsed) || parsed.url !== url || typeof parsed.fetchedAt !== "number") return undefined;
		return {
			url,
			fetchedAt: parsed.fetchedAt,
			...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
			data: parsed.data,
		};
	} catch {
		// A missing or unreadable cache is simply no cache.
		return undefined;
	}
}

async function writeIndexCache(agentDir: string, cache: IndexCacheFile): Promise<void> {
	const filePath = indexCachePath(agentDir, cache.url);
	try {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await writeFileAtomically(
			filePath,
			`${JSON.stringify(cache)}
`,
		);
	} catch (error) {
		// The catalog still works without a cache; the next run refetches.
		logger.debug("Connector index cache could not be written", {
			url: cache.url,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Read a remote index, reusing the copy on disk.
 *
 * A fresh copy is used without a request. An older one is revalidated with
 * `If-None-Match`, and a failed request falls back to it rather than dropping
 * the entries: a network outage must not make a connector disappear from the
 * page. Only a first run with no copy and no answer reports an empty index.
 */
async function fetchIndex(
	agentDir: string,
	url: string,
	warnings: string[],
	options: { force?: boolean } = {},
): Promise<ConnectorCatalogEntry[]> {
	const cached = await readIndexCache(agentDir, url);
	const fresh = cached !== undefined && Date.now() - cached.fetchedAt < INDEX_CACHE_TTL_MS;
	if (cached && fresh && options.force !== true) {
		return parseIndex(cached.data, url, "remote", warnings);
	}

	const fallbackToCache = (reason: string): ConnectorCatalogEntry[] => {
		if (!cached) {
			warnings.push(`${url}: ${reason}`);
			return [];
		}
		const age = Math.round((Date.now() - cached.fetchedAt) / 3_600_000);
		warnings.push(`${url}: ${reason}; using the index cached ${age}h ago`);
		return parseIndex(cached.data, url, "remote", warnings);
	};

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: "application/json",
				...(cached?.etag ? { "if-none-match": cached.etag } : {}),
			},
			signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		return fallbackToCache(error instanceof Error ? error.message : String(error));
	}

	if (response.status === 304 && cached) {
		await writeIndexCache(agentDir, { ...cached, fetchedAt: Date.now() });
		return parseIndex(cached.data, url, "remote", warnings);
	}
	if (!response.ok) return fallbackToCache(`HTTP ${response.status}`);

	let data: unknown;
	try {
		data = await response.json();
	} catch (error) {
		return fallbackToCache(`invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	const etag = response.headers.get("etag") ?? undefined;
	await writeIndexCache(agentDir, { url, fetchedAt: Date.now(), ...(etag ? { etag } : {}), data });
	return parseIndex(data, url, "remote", warnings);
}

interface PackageDisplay {
	name?: string;
	description?: string;
	examples?: string[];
	examplesZh?: string[];
	icon?: string;
	docsUrl?: string;
	authMode?: ConnectorAuthMode;
	oauth?: ConnectorOAuthSpec;
}

function readPackageDisplay(plugin: Record<string, unknown>): PackageDisplay {
	const extensions = isRecord(plugin.extensions) ? plugin.extensions : {};
	const musepi = isRecord(extensions["musepi.connector"]) ? extensions["musepi.connector"] : {};
	const legacy = isRecord(extensions["ai.workbuddy"]) ? extensions["ai.workbuddy"] : {};
	const display = isRecord(musepi.display) ? musepi.display : isRecord(legacy.display) ? legacy.display : {};
	const auth = isRecord(musepi.auth) ? musepi.auth : isRecord(legacy.auth) ? legacy.auth : {};
	return {
		name: readString(display.name, 128),
		description: readString(display.description) ?? readString(plugin.description),
		examples: readStringArray(display.examples) ?? readStringArray(display.examples_en),
		examplesZh: readStringArray(display.examplesZh) ?? readStringArray(display.examples_zh),
		icon: readString(display.icon, 2_048),
		docsUrl: readString(display.docsUrl, 2_048),
		authMode: typeof auth.mode === "string" ? parseAuthMode(auth.mode) : undefined,
		oauth: parseOAuthSpec(musepi.oauth ?? legacy.oauth),
	};
}

function resolvePackageIcon(dir: string, display: PackageDisplay): string | undefined {
	if (display.icon && (isHttpUrl(display.icon) || path.isAbsolute(display.icon))) return display.icon;
	for (const candidate of ["assets/icon.png", "assets/icon.svg", "icon.png", "icon.svg"]) {
		const absolute = path.join(dir, candidate);
		if (fs.existsSync(absolute)) return absolute;
	}
	return undefined;
}

async function loadPackageDir(dir: string, warnings: string[]): Promise<ConnectorCatalogEntry | undefined> {
	let pluginText: string;
	try {
		pluginText = await fs.promises.readFile(path.join(dir, "plugin.json"), "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			warnings.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}

	const readOptional = async (relative: string): Promise<string | undefined> => {
		try {
			return await fs.promises.readFile(path.join(dir, relative), "utf8");
		} catch (error) {
			if (!isEnoent(error))
				warnings.push(`${dir}/${relative}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};
	const [mcpText, cliText, tokenText] = await Promise.all([
		readOptional("mcp.json"),
		Promise.all([readOptional("ai.workbuddy/cli.json"), readOptional("musepi.connector/cli.json")]).then(
			([legacy, modern]) => modern ?? legacy,
		),
		Promise.all([
			readOptional("ai.workbuddy/token-schema.json"),
			readOptional("musepi.connector/token-schema.json"),
		]).then(([legacy, modern]) => modern ?? legacy),
	]);

	let plugin: Record<string, unknown>;
	let mcp: Record<string, unknown> | undefined;
	let cliRaw: unknown;
	try {
		plugin = JSON.parse(pluginText) as Record<string, unknown>;
		if (mcpText) mcp = JSON.parse(mcpText) as Record<string, unknown>;
		if (cliText) cliRaw = JSON.parse(cliText);
	} catch (error) {
		warnings.push(`${dir}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
	if (!isRecord(plugin)) return undefined;

	let tokenSchema: ConnectorTokenSchema | undefined;
	if (tokenText) {
		try {
			tokenSchema = parseTokenSchema(JSON.parse(tokenText), warnings, `${dir}/token-schema.json`);
		} catch (error) {
			warnings.push(
				`${dir}/token-schema.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	const id = readString(plugin.name, 64) ?? path.basename(dir);
	if (!CONNECTOR_ID_PATTERN.test(id)) {
		warnings.push(`${dir}: invalid connector id "${id}"`);
		return undefined;
	}
	const servers = mcp && isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
	const first = Object.values(servers).find(isRecord);
	const server = first ? parseServerSpec({ ...first, type: first.type }, warnings) : undefined;
	const cli = parseCliSpec(cliRaw, warnings, `${dir}/cli.json`);
	if (!server && !cli) return undefined;

	const display = readPackageDisplay(plugin);
	const authMode = cli && !server ? "none" : (display.authMode ?? (tokenSchema ? "token" : "oauth"));
	if (authMode === "token" && !tokenSchema) {
		warnings.push(`${dir}: token package has no token-schema.json`);
		return undefined;
	}
	const entry: ConnectorCatalogEntry = {
		id,
		name: display.name ?? id,
		description: display.description ?? "",
		...(server ? { server } : {}),
		...(cli ? { cli } : {}),
		auth: { mode: authMode },
		source: path.join(dir, "plugin.json"),
		sourceKind: "package",
	};
	if (tokenSchema) entry.tokenSchema = tokenSchema;
	const category = readString(plugin.category, 64);
	if (category) entry.category = category;
	const version = readString(plugin.version, 64);
	if (version) entry.version = version;
	const icon = resolvePackageIcon(dir, display);
	if (icon) entry.icon = icon;
	if (display.docsUrl && isHttpUrl(display.docsUrl)) entry.docsUrl = display.docsUrl;
	if (display.examples) entry.examples = display.examples;
	if (display.examplesZh) entry.examplesZh = display.examplesZh;
	if (display.oauth) entry.oauth = display.oauth;
	return entry;
}

async function loadPackageDirs(agentDir: string, warnings: string[]): Promise<ConnectorCatalogEntry[]> {
	const root = path.join(agentDir, CONNECTOR_DIR_NAME, "marketplace");
	let dirs: fs.Dirent[];
	try {
		dirs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return [];
	}
	const entries: ConnectorCatalogEntry[] = [];
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		const entry = await loadPackageDir(path.join(root, dir.name), warnings);
		if (entry) entries.push(entry);
	}
	return entries;
}

function catalogKey(agentDir: string, env: Readonly<Record<string, string | undefined>>): string {
	return `${agentDir}\u0000${env.MUSEPI_CONNECTOR_CATALOG ?? ""}`;
}

/** Sources from the strongest claim on an id to the weakest. */
const SOURCE_RANK: Record<ConnectorCatalogEntry["sourceKind"], number> = {
	index: 3,
	remote: 3,
	package: 2,
	bundled: 1,
};

function dedupe(entries: ConnectorCatalogEntry[], warnings: string[]): ConnectorCatalogEntry[] {
	const byId = new Map<string, ConnectorCatalogEntry>();
	for (const entry of entries) {
		const existing = byId.get(entry.id);
		if (existing) {
			// A stronger source replacing a weaker one is the intended layering,
			// not a conflict. Only two declarations in the same tier that
			// disagree are worth a warning.
			const rank = SOURCE_RANK[entry.sourceKind];
			const existingRank = SOURCE_RANK[existing.sourceKind];
			if (rank === existingRank && JSON.stringify(existing.server) !== JSON.stringify(entry.server)) {
				warnings.push(`connector "${entry.id}" is declared twice; keeping ${existing.source}`);
			} else if (rank > existingRank) {
				byId.set(entry.id, entry);
			}
			continue;
		}
		byId.set(entry.id, entry);
	}
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The user's own entries, written by the import flow.
 *
 * They are stored already normalized, so they are read straight into the
 * catalog rather than parsed again. Their rank sits above a package and below
 * the hand-written index, so an imported server can be overridden by a
 * deliberate entry.
 */
async function readCustomIndex(agentDir: string, warnings: string[]): Promise<ConnectorCatalogEntry[]> {
	const entries = await readCustomEntries(agentDir);
	return entries.map(entry => ({
		...entry,
		source: entry.source || connectorCustomPath(agentDir),
		sourceKind: "index" as const,
	}));
}

/** Normalize the entries that ship with the product. */
function bundledEntries(warnings: string[]): ConnectorCatalogEntry[] {
	const entries: ConnectorCatalogEntry[] = [];
	for (const raw of BUNDLED_CONNECTORS) {
		const entry = parseCatalogEntry(raw, "bundled catalog", "bundled", warnings);
		if (entry) entries.push(entry);
	}
	return entries;
}

/** Load and normalize the catalog. Never throws for a bad source. */
export async function loadConnectorCatalog(options: LoadConnectorCatalogOptions = {}): Promise<ConnectorCatalogResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const env = options.env ?? process.env;
	const key = catalogKey(agentDir, env);
	if (!options.refresh && cache && cache.key === key && Date.now() - cache.at < CATALOG_CACHE_TTL_MS) {
		return { entries: cache.entries, warnings: cache.warnings };
	}

	const warnings: string[] = [];
	const entries: ConnectorCatalogEntry[] = [];
	// `auto` opts into the index this app checks on its own; `off` (or leaving
	// it unset) keeps the catalog local. A path or URL names one directly.
	//
	// The automatic check is opt-in rather than default because it is a
	// network call on a settings screen: the host it lives on is not reachable
	// everywhere, and a failed request would stall the first open for the
	// request timeout before falling back to a catalog that was already local.
	const configured = env.MUSEPI_CONNECTOR_CATALOG?.trim();
	const normalized = configured?.toLowerCase();
	const disabled = normalized === "off";
	const remoteUrl =
		normalized === "auto"
			? DEFAULT_CATALOG_URL
			: configured && !disabled && isHttpUrl(configured)
				? configured
				: undefined;
	if (remoteUrl) {
		entries.push(...(await fetchIndex(agentDir, remoteUrl, warnings, { force: options.refresh === true })));
	}
	if (configured && !disabled && normalized !== "auto" && !isHttpUrl(configured)) {
		entries.push(
			...(await readIndexFile(path.isAbsolute(configured) ? configured : path.join(agentDir, configured), warnings)),
		);
	}
	entries.push(...(await readIndexFile(path.join(agentDir, CONNECTOR_DIR_NAME, CONNECTOR_INDEX_FILE), warnings)));
	entries.push(...(await readCustomIndex(agentDir, warnings)));
	entries.push(...(await loadPackageDirs(agentDir, warnings)));
	entries.push(...bundledEntries(warnings));

	const result: ConnectorCatalogResult = { entries: dedupe(entries, warnings), warnings };
	if (warnings.length > 0) logger.debug("Connector catalog warnings", { warnings });
	cache = { key, at: Date.now(), ...result };
	return result;
}

/** Drop the process cache so the next load observes a changed source. */
export function clearConnectorCatalogCache(): void {
	cache = undefined;
}
