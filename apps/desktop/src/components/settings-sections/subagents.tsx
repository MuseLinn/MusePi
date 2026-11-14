import { type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { dispatchSettingsChanged } from "../../lib/settings-events";
import { GuiSelect, type SelectOption } from "../GuiSelect";
import type { SchemaItem } from "../SchemaSettings";
import { SchemaTabSection } from "./schema";

const SUBAGENT_MODEL_KEY = "task.subagentModel";
const TASKS_TAB = "tasks";

interface CatalogModel {
	id: string;
	provider?: string;
}

/**
 * Subagent model picker: empty follows each agent's own chain (agent
 * frontmatter, then the session model); a role alias or provider-qualified
 * catalog model pins one model for every subagent without an explicit spawn
 * model or per-agent override.
 */
function SubagentModelRow({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [value, setValue] = useState("");
	const [roles, setRoles] = useState<string[]>([]);
	const [models, setModels] = useState<CatalogModel[]>([]);
	const [item, setItem] = useState<SchemaItem | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, unknown> | null>("settings.get", { keys: [SUBAGENT_MODEL_KEY, "knownRoleIds"] })
			.then(res => {
				if (!alive) return;
				const stored = res?.[SUBAGENT_MODEL_KEY];
				setValue(typeof stored === "string" ? stored : "");
				const known = res?.knownRoleIds;
				setRoles(Array.isArray(known) ? known.filter((role): role is string => typeof role === "string") : []);
			})
			.catch(() => {});
		void rpc
			.request<CatalogModel[]>("models.listAvailable")
			.then(list => {
				if (alive) setModels(list ?? []);
			})
			.catch(() => {});
		// Label/description come from the daemon schema (the same single source
		// the TUI panel renders) instead of a second copy in this file.
		void rpc
			.request<Record<string, SchemaItem[]>>("settings.schema", { tabs: [TASKS_TAB] })
			.then(res => {
				const found = (res.tasks ?? []).find(entry => entry.key === SUBAGENT_MODEL_KEY);
				if (alive && found) setItem(found);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const commit = (next: string): void => {
		if (!rpc || next === value) return;
		const previous = value;
		setValue(next);
		void rpc
			.request("settings.set", { key: SUBAGENT_MODEL_KEY, value: next })
			.then(() => {
				dispatchSettingsChanged(SUBAGENT_MODEL_KEY);
				setError(null);
			})
			.catch(err => {
				setValue(previous);
				setError(err instanceof Error ? err.message : String(err));
			});
	};

	const label = item?.ui?.label;
	if (!item || !label) return null;

	const options: SelectOption<string>[] = [{ value: "", label: t("settings.subagentModelFollowDefault") }];
	const seen = new Set([""]);
	const add = (ref: string): void => {
		if (seen.has(ref)) return;
		seen.add(ref);
		options.push({ value: ref, label: ref });
	};
	for (const role of roles) add(`@${role}`);
	for (const model of models) add(model.provider ? `${model.provider}/${model.id}` : model.id);
	// A stored selector these lists no longer offer (hand-written pattern,
	// unavailable provider) stays selectable so the row never misreports it.
	add(value);

	return (
		<>
			<div className="gui-settings-row">
				<div className="min-w-0 flex-1">
					<div className="gui-settings-row-label">{t(label as TranslationKey)}</div>
					{item.ui?.description && (
						<div className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
							{t(item.ui.description as TranslationKey)}
						</div>
					)}
				</div>
				<GuiSelect
					className="gui-settings-select !w-auto max-w-[240px]"
					value={value}
					onChange={commit}
					ariaLabel={t(label as TranslationKey)}
					options={options}
				/>
			</div>
			{error && <div className="px-1 pb-1 text-[12.5px] text-[var(--color-warning)]">{error}</div>}
		</>
	);
}

/** Settings → 任务与子智能体: TUI tasks-tab parity (modes, subagent
 *  limits, isolation, commands & skills groups), schema driven — the
 *  subagent model row is a custom picker because its choices are model
 *  roles plus the catalog, which the schema renderer cannot enumerate.
 *  The live subagent roster lives in the session right rail
 *  (AgentsPanel), not in settings (dedupe 2026-08-11). */
export function SubagentsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.tasksSubagents")}</h2>
			<SubagentModelRow rpc={rpc} />
			<SchemaTabSection rpc={rpc} tabs={[TASKS_TAB]} excludeKeys={[SUBAGENT_MODEL_KEY]} />
		</>
	);
}
