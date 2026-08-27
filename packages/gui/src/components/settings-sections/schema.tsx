import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { type SchemaItem, SchemaSettings } from "../SchemaSettings";
import { TaskCardStylePreview } from "./general";

/** Schema-driven settings tab: fetches settings.schema + current values
 *  from the daemon and renders every item via {@link SchemaSettings}.
 *  Changes are optimistic settings.set calls (reverted on failure). */
export function SchemaTabSection({
	rpc,
	tabs,
	groups,
	excludeGroups,
}: {
	rpc: RpcClient | null;
	tabs: string[];
	/** Optional ui.group filter: when set, only items in these groups
	 * render (e.g. the voice page shows the interaction tab's "Speech"
	 * group without duplicating the whole tab). */
	groups?: readonly string[];
	/** Optional ui.group exclude: items in these groups are skipped even
	 * when no `groups` include filter is set (e.g. interaction tab
	 * excludes "Speech" so it only lives on the voice tab). */
	excludeGroups?: readonly string[];
}): ReactNode {
	const [schema, setSchema] = useState<SchemaItem[] | null>(null);
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, SchemaItem[]>>("settings.schema", { tabs })
			.then(async res => {
				if (!alive) return;
				const all = (res[tabs[0] ?? ""] ?? []) as SchemaItem[];
				const items = groups
					? all.filter(i => i.ui?.group !== undefined && groups.includes(i.ui.group))
					: excludeGroups
						? all.filter(i => i.ui?.group === undefined || !excludeGroups.includes(i.ui.group))
						: all;
				setSchema(items);
				const vals = await rpc.request<Record<string, unknown>>("settings.get", { keys: items.map(i => i.key) });
				if (alive) {
					setValues(vals ?? {});
					setError(null);
				}
			})
			.catch(err => alive && setError(err instanceof Error ? err.message : String(err)));
		return () => {
			alive = false;
		};
	}, [rpc, tabs, groups]);
	const onChange = (key: string, value: unknown): void => {
		if (!rpc) return;
		// Optimistic flip; revert on failure.
		setValues(prev => ({ ...prev, [key]: value }));
		void rpc
			.request("settings.set", { key, value })
			.then(() => setError(null))
			.catch(err => {
				setValues(prev => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
				setError(err instanceof Error ? err.message : String(err));
			});
	};
	return (
		<SchemaSettings
			items={schema ?? []}
			values={values}
			onChange={onChange}
			error={error}
			renderExtra={(key, value, commit) =>
				key === "display.taskCardStyle" ? (
					<TaskCardStylePreview value={value} onPick={style => commit("display.taskCardStyle", style)} />
				) : null
			}
		/>
	);
}
