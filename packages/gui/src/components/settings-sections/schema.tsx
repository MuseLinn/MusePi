import type {
	ReactNode,
} from "react";
import {
	useEffect,
	useState,
} from "react";
import type {
	RpcClient,
} from "../../lib/rpc";
import {
	type SchemaItem,
	SchemaSettings,
} from "../SchemaSettings";
import { TaskCardStylePreview } from "./general";

/** Schema-driven settings tab: fetches settings.schema + current values
 *  from the daemon and renders every item via {@link SchemaSettings}.
 *  Changes are optimistic settings.set calls (reverted on failure). */
export function SchemaTabSection({ rpc, tabs }: { rpc: RpcClient | null; tabs: string[] }): ReactNode {
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
				const items = (res[tabs[0] ?? ""] ?? []) as SchemaItem[];
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
	}, [rpc, tabs]);
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
