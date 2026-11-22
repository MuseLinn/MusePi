/** `plugin_manager` — profile plugin rows, bundles, installs and version exemptions. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, Kv, KvGrid, Note, Output, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, num, resultTextOf, str } from "../util";

interface PluginRow {
	id: string;
	name: string;
	state: "enabled" | "disabled" | "conditional";
	layers: string[];
}

interface Bundle {
	name: string;
	version: string;
	enabled: boolean;
}

interface Payload {
	ok: boolean;
	error: string | null;
	entries: PluginRow[];
	bundles: Bundle[];
	total: number | null;
	runtimeVersion: string | null;
	exemptions: Array<{ target: string; versions: string[] }>;
	name: string | null;
	version: string | null;
	application: "applied" | "pending" | null;
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
	const entries: PluginRow[] = [];
	if (Array.isArray(parsed.entries)) {
		for (const item of parsed.entries) {
			if (!isRecord(item)) continue;
			const state = item.state;
			entries.push({
				id: str(item.id) ?? "",
				name: str(item.name) ?? "",
				state: state === "enabled" || state === "disabled" || state === "conditional" ? state : "disabled",
				layers: Array.isArray(item.layers) ? item.layers.filter((l): l is string => typeof l === "string") : [],
			});
		}
	}
	const bundles: Bundle[] = [];
	if (Array.isArray(parsed.bundles)) {
		for (const item of parsed.bundles) {
			if (!isRecord(item)) continue;
			bundles.push({
				name: str(item.name) ?? "",
				version: str(item.version) ?? "",
				enabled: item.enabled === true,
			});
		}
	}
	const exemptions: Array<{ target: string; versions: string[] }> = [];
	if (isRecord(parsed.exemptions)) {
		for (const [target, versions] of Object.entries(parsed.exemptions)) {
			exemptions.push({
				target,
				versions: Array.isArray(versions) ? versions.filter((v): v is string => typeof v === "string") : [],
			});
		}
	}
	const application = parsed.application;
	return {
		ok: parsed.ok === true,
		error: str(parsed.error),
		entries,
		bundles,
		total: num(parsed.total),
		runtimeVersion: str(parsed.runtimeVersion),
		exemptions,
		name: str(parsed.name),
		version: str(parsed.version),
		application: application === "applied" || application === "pending" ? application : null,
		message: str(parsed.message),
		nextStep: str(parsed.nextStep),
		pendingBuilds: Array.isArray(parsed.pendingBuilds)
			? parsed.pendingBuilds.filter((item): item is string => typeof item === "string")
			: [],
	};
}

function stateBadge(state: PluginRow["state"]): ReactNode {
	if (state === "enabled") return <Badge tone="ok">{t("tools.enabled")}</Badge>;
	if (state === "conditional") return <Badge tone="warn">{t("tools.pluginConditional")}</Badge>;
	return <Badge>{t("tools.disabled")}</Badge>;
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
		case "list_bundles": {
			const count = payload?.total ?? payload?.bundles.length ?? null;
			return count !== null ? (
				<Badge tone="accent">{t("tools.bundleCountWithCount", { count: String(count) })}</Badge>
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
		case "set_bundle":
			return target !== null ? (
				<>
					<span>{target}</span>
					<Badge tone={args.enabled === true ? "ok" : undefined}>
						{args.enabled === true ? t("tools.enabled") : t("tools.disabled")}
					</Badge>
				</>
			) : null;
		case "install_bundle":
			return (
				<>
					{target !== null && <span>{target}</span>}
					{payload?.version !== null && payload?.version !== undefined && (
						<Badge tone="ok">{payload.version}</Badge>
					)}
				</>
			);
		case "remove_bundle":
			return target !== null ? <span>{target}</span> : null;
		case "list_version_exemptions": {
			const count = payload?.exemptions.length ?? null;
			return count !== null ? (
				<Badge tone="accent">{t("tools.exemptionsWithCount", { count: String(count) })}</Badge>
			) : null;
		}
		case "set_version_exemption":
			return target !== null ? (
				<>
					<span>{target}</span>
					<Badge tone={args.enabled === true ? "warn" : undefined}>
						{args.enabled === true ? t("tools.exemptionGranted") : t("tools.exemptionRevoked")}
					</Badge>
				</>
			) : null;
		default:
			return null;
	}
}

function Body({ result }: ToolRenderProps): ReactNode {
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
					<Row key={entry.id} k={entry.id}>
						<Badges items={[entry.name, stateBadge(entry.state)]} />
						{entry.layers.length > 0 && <span className="tv-faint">{entry.layers.join(" → ")}</span>}
					</Row>
				))}
			</div>
		);
	}
	if (payload.bundles.length > 0) {
		return (
			<div className="tv-list">
				{payload.bundles.map(bundle => (
					<Row key={bundle.name} k={bundle.name}>
						<Badges
							items={[
								bundle.version,
								bundle.enabled ? (
									<Badge tone="ok">{t("tools.enabled")}</Badge>
								) : (
									<Badge>{t("tools.disabled")}</Badge>
								),
							]}
						/>
					</Row>
				))}
			</div>
		);
	}
	if (payload.exemptions.length > 0 || payload.runtimeVersion !== null) {
		return (
			<>
				{payload.runtimeVersion !== null && (
					<KvGrid>
						<Kv k={t("tools.runtimeVersion")}>{payload.runtimeVersion}</Kv>
					</KvGrid>
				)}
				<div className="tv-list">
					{payload.exemptions.map(entry => (
						<Row key={entry.target} k={entry.target}>
							<Badges items={entry.versions} />
						</Row>
					))}
				</div>
				{payload.exemptions.length === 0 && <Note>{t("tools.noExemptions")}</Note>}
			</>
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
