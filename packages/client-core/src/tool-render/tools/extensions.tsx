/**
 * Extension and dynamic-plugin lifecycle tools.
 *
 * `extension_*` manages session-level legacy extensions (Track B); `ext_*`
 * defines/activates sandboxed Cordis-style plugins. Both arrive over the wire
 * as `write xd://<tool>` device dispatches and answer with a JSON object as
 * their text content, so one shared card renders the whole family and the
 * per-tool identity comes from `TOOL_RENDER_CARD_LABELS`.
 *
 * The body models the fields the tools actually return (paths, tool lists,
 * errors, plugin/package ids) and falls back to the raw payload only when the
 * text is not the expected JSON.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, Kv, KvGrid, Note, Output, PathText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, num, resultTextOf, str, truncate } from "../util";

interface ExtensionEntry {
	path: string;
	tools: string[];
	modes: string[];
	promptSections: string[];
	components: string[];
}

interface PluginEntry {
	pluginId: string;
	name: string;
	purpose: string;
	packageCount: number | null;
	activePackageId: string | null;
	activeToolNames: string[];
}

/** Fields the lifecycle tools return; every member is optional wire JSON. */
interface Payload {
	ok: boolean | null;
	error: string | null;
	deferred: boolean;
	loaded: boolean | null;
	addedTools: string[];
	removedTools: string[];
	errors: string[];
	extensions: ExtensionEntry[];
	allToolNames: string[];
	pluginId: string | null;
	packageId: string | null;
	name: string | null;
	purpose: string | null;
	tools: string[];
	stopped: string | null;
	removed: string | null;
	wasRunning: boolean;
	plugins: PluginEntry[];
	plugin: PluginEntry | null;
	restoredFrom: string | null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}

function extensionEntries(value: unknown): ExtensionEntry[] {
	if (!Array.isArray(value)) return [];
	const out: ExtensionEntry[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		out.push({
			path: str(item.path) ?? "",
			tools: strings(item.tools),
			modes: Array.isArray(item.modes)
				? item.modes
						.map(mode => (isRecord(mode) ? (str(mode.label) ?? str(mode.id)) : null))
						.filter((name): name is string => name !== null && name.length > 0)
				: [],
			promptSections: strings(item.promptSections),
			components: Array.isArray(item.components)
				? item.components
						.map(component =>
							isRecord(component)
								? [str(component.slot), str(component.label)].filter(Boolean).join(" · ")
								: null,
						)
						.filter((name): name is string => name !== null && name.length > 0)
				: [],
		});
	}
	return out;
}

function pluginEntries(value: unknown): PluginEntry[] {
	if (!Array.isArray(value)) return [];
	const out: PluginEntry[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		out.push({
			pluginId: str(item.pluginId) ?? "",
			name: str(item.name) ?? "",
			purpose: str(item.purpose) ?? "",
			packageCount: num(item.packageCount),
			activePackageId: str(item.activePackageId),
			activeToolNames: strings(item.activeToolNames),
		});
	}
	return out;
}

function pluginEntry(value: unknown): PluginEntry | null {
	if (!isRecord(value)) return null;
	const entries = pluginEntries([value]);
	return entries[0] ?? null;
}

/** Parse the tool's JSON text payload; null when it is prose or an outer dispatch error. */
function payloadOf(result: ToolRenderProps["result"]): Payload | null {
	const text = resultTextOf(result).trim();
	if (text.length === 0 || text[0] !== "{") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	return {
		ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
		error: str(parsed.error),
		deferred: parsed.deferred === true,
		loaded: typeof parsed.loaded === "boolean" ? parsed.loaded : null,
		addedTools: strings(parsed.addedTools),
		removedTools: strings(parsed.removedTools),
		errors: strings(parsed.errors),
		extensions: extensionEntries(parsed.extensions),
		allToolNames: strings(parsed.allToolNames),
		pluginId: str(parsed.pluginId),
		packageId: str(parsed.packageId),
		name: str(parsed.name),
		purpose: str(parsed.purpose),
		tools: strings(parsed.tools),
		stopped: str(parsed.stopped),
		removed: str(parsed.removed),
		wasRunning: parsed.wasRunning === true,
		plugins: pluginEntries(parsed.plugins),
		plugin: pluginEntry(parsed.plugin),
		restoredFrom: str(parsed.restoredFrom),
	};
}

function statusBadge(payload: Payload | null): ReactNode {
	if (payload === null || payload.ok === null) return null;
	if (!payload.ok) return <Badge tone="err">{t("tools.extensionFailed")}</Badge>;
	return <Badge tone="ok">{t("tools.extensionOk")}</Badge>;
}

/** Chips for tool/slot name lists; the count badge keeps long lists bounded. */
function nameBadges(names: string[], limit = 4): ReactNode {
	if (names.length === 0) return null;
	return (
		<Badges
			items={[
				...names.slice(0, limit),
				names.length > limit && (
					<Badge tone="accent">{t("tools.moreWithCount", { count: String(names.length - limit) })}</Badge>
				),
			]}
		/>
	);
}

function pathArg(args: Record<string, unknown>): string | null {
	return str(args.path);
}

function pluginIdArg(args: Record<string, unknown>): string | null {
	return str(args.pluginId);
}

function Summary({ name, args, result }: ToolRenderProps): ReactNode {
	const payload = payloadOf(result);
	switch (name) {
		case "extensions_list":
			return payload !== null && payload.extensions.length > 0 ? (
				<Badge tone="accent">
					{t("tools.extensionCountWithCount", { count: String(payload.extensions.length) })}
				</Badge>
			) : null;
		case "extension_status": {
			const path = pathArg(args);
			if (path !== null) return <PathText path={path} />;
			const count = payload?.extensions.length ?? 0;
			return count > 0 ? (
				<Badge tone="accent">{t("tools.extensionCountWithCount", { count: String(count) })}</Badge>
			) : (
				<span className="tv-muted">{t("tools.extensionAll")}</span>
			);
		}
		case "extension_load":
		case "extension_reload":
		case "extension_validate":
		case "extension_rollback": {
			const path = pathArg(args);
			const status =
				name === "extension_validate" ? (
					payload?.ok === true ? (
						<Badge tone="ok">{t("tools.extensionPassed")}</Badge>
					) : (
						statusBadge(payload)
					)
				) : payload?.ok === false ? (
					<Badge tone="err">{t("tools.extensionFailed")}</Badge>
				) : null;
			return (
				<>
					{path !== null && <PathText path={path} />}
					{payload?.deferred === true && <Badge>{t("tools.extensionDeferred")}</Badge>}
					{status}
				</>
			);
		}
		case "ext_define": {
			const pluginName = payload?.name ?? str(args.name);
			if (pluginName === null || pluginName.length === 0) return null;
			const purpose = payload?.purpose ?? str(args.purpose);
			return (
				<>
					<span>{pluginName}</span>
					{purpose !== null && purpose.length > 0 && (
						<>
							<span className="tv-faint"> · </span>
							<span className="tv-muted">{truncate(purpose, 48)}</span>
						</>
					)}
					{payload?.pluginId !== null && payload?.pluginId !== undefined && (
						<>
							<span className="tv-faint"> · </span>
							<span className="tv-faint">{payload.pluginId}</span>
						</>
					)}
				</>
			);
		}
		case "ext_run": {
			const pluginId = payload?.pluginId ?? pluginIdArg(args);
			if (pluginId === null) return null;
			return (
				<>
					<span>{pluginId}</span>
					{payload !== null && payload.tools.length > 0 && (
						<Badge tone="accent">{t("tools.toolsWithCount", { count: String(payload.tools.length) })}</Badge>
					)}
				</>
			);
		}
		case "ext_stop":
		case "ext_undefine": {
			const pluginId = payload?.stopped ?? payload?.removed ?? pluginIdArg(args);
			if (pluginId === null) return null;
			return (
				<>
					<span>{pluginId}</span>
					{payload?.wasRunning === true && <Badge>{t("tools.pluginWasRunning")}</Badge>}
				</>
			);
		}
		case "ext_inspect": {
			const pluginId = payload?.plugin?.pluginId ?? pluginIdArg(args);
			if (pluginId !== null) {
				return (
					<>
						<span>{pluginId}</span>
						{payload?.plugin !== null && payload?.plugin !== undefined && (
							<Badge>
								{t("tools.packageCountWithCount", { count: String(payload.plugin.packageCount ?? 0) })}
							</Badge>
						)}
					</>
				);
			}
			const count = payload?.plugins.length ?? 0;
			return count > 0 ? (
				<Badge tone="accent">{t("tools.pluginCountWithCount", { count: String(count) })}</Badge>
			) : (
				<span className="tv-muted">{t("tools.pluginAll")}</span>
			);
		}
		default:
			return <span className="tv-muted">{name}</span>;
	}
}

function errorsBlock(label: string, errors: string[]): ReactNode {
	if (errors.length === 0) return null;
	return <Output text={errors.join("\n")} title={label} error maxLines={12} />;
}

function extensionRow(entry: ExtensionEntry): ReactNode {
	return (
		<Row key={entry.path} k={entry.path.length > 0 ? <PathText path={entry.path} /> : "?"}>
			<Badges
				items={[
					entry.tools.length > 0 && t("tools.toolsWithCount", { count: String(entry.tools.length) }),
					entry.modes.length > 0 && t("tools.modesWithCount", { count: String(entry.modes.length) }),
					entry.promptSections.length > 0 &&
						t("tools.promptSectionsWithCount", { count: String(entry.promptSections.length) }),
					entry.components.length > 0 &&
						t("tools.slotComponentsWithCount", { count: String(entry.components.length) }),
				]}
			/>
			{nameBadges(entry.tools)}
			{nameBadges(entry.components)}
		</Row>
	);
}

function pluginRow(entry: PluginEntry): ReactNode {
	return (
		<Row key={entry.pluginId} k={entry.pluginId}>
			<Badges
				items={[
					entry.name,
					entry.activePackageId !== null && t("tools.pluginActiveWithId", { id: entry.activePackageId }),
					t("tools.packageCountWithCount", { count: String(entry.packageCount ?? 0) }),
				]}
			/>
			{entry.purpose.length > 0 && <span className="tv-muted">{entry.purpose}</span>}
			{nameBadges(entry.activeToolNames)}
		</Row>
	);
}

function Body({ name, args, result }: ToolRenderProps): ReactNode {
	const payload = payloadOf(result);
	const raw = resultTextOf(result).trim();
	if (payload === null) {
		if (raw.length === 0) return null;
		if (result?.isError === true) return <Note tone="err">{raw}</Note>;
		return <Output text={raw} title={t("tools.raw")} variant="code" maxLines={16} />;
	}
	const path = pathArg(args);
	const success = payload.ok === true;
	return (
		<>
			<Badges
				items={[
					statusBadge(payload),
					payload.deferred && t("tools.extensionDeferred"),
					payload.loaded === true && t("tools.extensionLoaded"),
					payload.loaded === false && t("tools.extensionNotLoaded"),
					payload.wasRunning && t("tools.pluginWasRunning"),
				]}
			/>
			<KvGrid>
				{path !== null && (
					<Kv k={t("tools.path")}>
						<PathText path={path} />
					</Kv>
				)}
				{payload.name !== null && <Kv k={t("tools.name")}>{payload.name}</Kv>}
				{payload.purpose !== null && <Kv k={t("tools.purpose")}>{payload.purpose}</Kv>}
				{payload.pluginId !== null && <Kv k={t("tools.pluginId")}>{payload.pluginId}</Kv>}
				{payload.packageId !== null && <Kv k={t("tools.packageId")}>{payload.packageId}</Kv>}
				{payload.restoredFrom !== null && (
					<Kv k={t("tools.restoredFrom")}>
						<PathText path={payload.restoredFrom} />
					</Kv>
				)}
			</KvGrid>
			{payload.error !== null && !success && <Note tone="err">{payload.error}</Note>}
			{payload.addedTools.length > 0 && (
				<Row k={t("tools.extensionAddedTools")}>{nameBadges(payload.addedTools, 8)}</Row>
			)}
			{payload.removedTools.length > 0 && (
				<Row k={t("tools.extensionRemovedTools")}>{nameBadges(payload.removedTools, 8)}</Row>
			)}
			{payload.tools.length > 0 && <Row k={t("tools.pluginActiveTools")}>{nameBadges(payload.tools, 8)}</Row>}
			{payload.allToolNames.length > 0 && (
				<Row k={t("tools.extensionAllTools")}>{nameBadges(payload.allToolNames, 8)}</Row>
			)}
			{payload.extensions.length > 0 && <div className="tv-list">{payload.extensions.map(extensionRow)}</div>}
			{payload.plugins.length > 0 && <div className="tv-list">{payload.plugins.map(pluginRow)}</div>}
			{payload.plugin !== null && <div className="tv-list">{pluginRow(payload.plugin)}</div>}
			{errorsBlock(t("tools.extensionErrors"), payload.errors)}
			{name === "extension_validate" && success && <Note tone="ok">{t("tools.extensionPassed")}</Note>}
		</>
	);
}

export const extensionsRenderer: ToolRenderer = { Summary, Body };

/** Extension/plugin lifecycle wire names — the run summary counts these as
 *  plugin operations instead of file edits. */
export const EXTENSION_TOOL_NAMES: readonly string[] = [
	"ext_define",
	"ext_inspect",
	"ext_run",
	"ext_stop",
	"ext_undefine",
	"extension_load",
	"extension_reload",
	"extension_rollback",
	"extension_status",
	"extension_validate",
	"extensions_list",
];
