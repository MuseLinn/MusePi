import {
	t,
} from "@musepi/desktop-web";
import type {
	ReactNode,
} from "react";
import {
	useEffect,
	useMemo,
	useState,
} from "react";
import type {
	RpcClient,
} from "../../lib/rpc";

interface SlashCommandItem {
	name: string;
	description?: string;
	subcommands?: { name: string; description?: string }[];
	kind: "command" | "skill";
	category: string;
}

/** Settings → 智能体 → 命令: read-only slash-command catalog (commands.list
 * — same source of truth as the composer's / completion and the TUI). */
export function CommandsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [items, setItems] = useState<SlashCommandItem[] | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<SlashCommandItem[]>("commands.list", {})
			.then(res => {
				if (alive) setItems(res ?? []);
			})
			.catch(() => alive && setItems([]));
		return () => {
			alive = false;
		};
	}, [rpc]);
	const groups = useMemo(() => {
		const map = new Map<string, SlashCommandItem[]>();
		for (const it of items ?? []) {
			const key = it.category || "command";
			const list = map.get(key) ?? [];
			list.push(it);
			map.set(key, list);
		}
		return [...map.entries()];
	}, [items]);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("commands")}</h2>
			<p className="gui-settings-page-desc">{t("commands settings")}</p>
			{items === null ? (
				<div className="text-[13px] text-[var(--color-text-faint)]">…</div>
			) : (
				groups.map(([cat, list]) => (
					<div key={cat} className="mb-2">
						<div className="gui-settings-nav-group">{cat}</div>
						{list.map(c => (
							<div key={c.name} className="gui-agent-card">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="font-mono text-[12.5px] font-medium">{c.name}</span>
										<span className="gui-provider-chip">{c.kind}</span>
									</div>
									{c.description && (
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">{c.description}</div>
									)}
									{c.subcommands && c.subcommands.length > 0 && (
										<div className="mt-0.5 flex flex-wrap gap-1">
											{c.subcommands.map(sc => (
												<span key={sc.name} className="gui-provider-chip">
													{sc.name}
												</span>
											))}
										</div>
									)}
								</div>
							</div>
						))}
					</div>
				))
			)}
		</>
	);
}
