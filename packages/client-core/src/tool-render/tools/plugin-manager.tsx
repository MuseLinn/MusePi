/** `plugin_manager` — installed plugin packages: list, enable/disable, install, remove. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, Kv, KvGrid, Note, Output, PathText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, num, resultTextOf, str } from "../util";

interface Entry {
	name: string;
	version: string;
	enabled: boolean;
	path: string | null;
}

interface Payload {
	ok: boolean;
	error: string | null;
	entries: Entry[];
	total: number | null;
	name: string | null;
	version: string | null;
	application: "applied" | "pending" | null;
	applied: number | null;
	deferred: number | null;
	message: string | null;
	nextStep: string | null;
	pendingBuilds: string[];
}

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
	const entries: Entry[] = [];
	if (Array.isArray(parsed.entries)) {
		for (const item of parsed.entries) {
			if (!isRecord(item)) continue;
			entries.push({
				name: str(item.name) ?? "",
				version: str(item.version) ?? "",
				enabled: item.enabled === true,
				path: str(item.path),
			});
		}
	}
	const application = parsed.application;
	return {
		ok: parsed.ok === true,
		error: str(parsed.error),
		entries,
		total: num(parsed.total),
		name: str(parsed.name),
		version: str(parsed.version),
		application: application === "applied" || application === "pending" ? application : null,
		applied: num(parsed.applied),
		deferred: num(parsed.deferred),
		message: str(parsed.message),
		nextStep: str(parsed.nextStep),
		pendingBuilds: Array.isArray(parsed.pendingBuilds)
			? parsed.pendingBuilds.filter((item): item is string => typeof item === "string")
			: [],
	};
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const payload = payloadOf(result);
	const action = str(args.action);
	const target = str(args.target);
	switch (action) {
		case "list_plugins": {
			const count = payload?.total ?? payload?.entries.length ?? null;
			return count !== null ? (
				<Badge tone="accent">{t("tools.pluginCountWithCount", { count: String(count) })}</Badge>
			) : null;
		}
		case "set_plugin":
			return target !== null ? (
				<>
					<span>{target}</span>
					<Badge tone={args.enabled === true ? "ok" : undefined}>
						{args.enabled === true ? t("tools.enabled") : t("tools.disabled")}
					</Badge>
				</>
			) : null;
		case "install_plugin":
			return (
				<>
					{target !== null && <span>{target}</span>}
					{payload?.version !== null && payload?.version !== undefined && (
						<Badge tone="ok">{payload.version}</Badge>
					)}
				</>
			);
		case "remove_plugin":
			return target !== null ? <span>{target}</span> : null;
		default:
			return null;
	}
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const payload = payloadOf(result);
	if (payload === null) {
		const raw = resultTextOf(result).trim();
		return raw.length > 0 ? <Output text={raw} variant="code" maxLines={16} /> : null;
	}
	if (payload.error !== null) return <Note tone="err">{payload.error}</Note>;
	if (payload.entries.length > 0) {
		return (
			<div className="tv-list">
				{payload.entries.map(entry => (
					<Row key={entry.name} k={entry.name}>
						<Badges items={[entry.version, entry.enabled ? t("tools.enabled") : t("tools.disabled")]} />
						{entry.path !== null && <PathText path={entry.path} />}
					</Row>
				))}
			</div>
		);
	}
	return (
		<>
			<Badges
				items={[
					payload.ok ? (
						<Badge tone="ok">{t("tools.extensionOk")}</Badge>
					) : (
						<Badge tone="err">{t("tools.extensionFailed")}</Badge>
					),
					payload.application === "pending" && <Badge tone="warn">{t("tools.pluginPending")}</Badge>,
				]}
			/>
			<KvGrid>
				{payload.name !== null && <Kv k={t("tools.name")}>{payload.name}</Kv>}
				{payload.version !== null && <Kv k={t("tools.version")}>{payload.version}</Kv>}
				{payload.pendingBuilds.length > 0 && (
					<Kv k={t("tools.pendingBuilds")}>{payload.pendingBuilds.join(", ")}</Kv>
				)}
			</KvGrid>
			{payload.message !== null && <Note tone={payload.ok ? "warn" : "err"}>{payload.message}</Note>}
			{payload.nextStep !== null && <Note tone="warn">{payload.nextStep}</Note>}
		</>
	);
}

export const pluginManagerRenderer: ToolRenderer = { Summary, Body };
