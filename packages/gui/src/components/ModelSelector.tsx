import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

export interface WireModel {
	id: string;
	name: string;
	provider: string;
}

/**
 * Live model selector — with a session it lists the session's available
 * models (daemon models.list) and switches via session.setModel. Without
 * one (welcome composer) it lists the registry catalog (models.listAvailable)
 * as a preselect-only picker; the parent applies the choice once a session
 * is created. The selected id is also published to the parent via onSelect.
 */
export function ModelSelector({
	rpc,
	sessionId,
	onSelect,
	presetId,
}: {
	rpc: RpcClient;
	sessionId: string | null;
	onSelect?(modelId: string | null, provider?: string): void;
	/** Preferred initial id (e.g. welcome-composer preselect applied to the
	 *  new session); kept when present in the listing. */
	presetId?: string | null;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<WireModel[]>([]);
	const [modelId, setModelId] = useState<string>("");
	// Searchable list (openchamber parity): filter by id/name/provider.
	const [query, setQuery] = useState("");
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);

	useEffect(() => {
		let alive = true;
		const method = sessionId ? "models.list" : "models.listAvailable";
		const params = sessionId ? { sessionId } : {};
		void rpc
			.request<WireModel[]>(method, params)
			.then(list => {
				if (!alive) return;
				setModels(list ?? []);
				const items = list ?? [];
				// Keep an existing selection (welcome preselect carried into the
				// session, or the presetId) when still available; else first.
				setModelId(prev => {
					const candidate = presetId ?? prev;
					if (candidate && items.some(m => m.id === candidate)) return candidate;
					return items[0]?.id ?? "";
				});
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc, sessionId, presetId]);

	useEffect(() => {
		const onDoc = (e: MouseEvent): void => {
			// Clicks inside the anchored button or the portal menu stay open;
			// the menu lives in document.body, so check both via composedPath.
			const path = e.composedPath();
			if (
				path.some(
					el =>
						el instanceof HTMLElement &&
						(el.classList?.contains("gui-model-btn") || el.classList?.contains("gui-menu-popup")),
				)
			) {
				return;
			}
			setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, []);

	const current = models.find(m => m.id === modelId);
	const label = current ? (current.name || current.id).replace(/^[^/]*\//, "") : t("model");

	const q = query.trim().toLowerCase();
	const filtered = q
		? models.filter(
				m =>
					m.id.toLowerCase().includes(q) ||
					m.name.toLowerCase().includes(q) ||
					m.provider.toLowerCase().includes(q),
			)
		: models;

	const select = (id: string): void => {
		const selected = models.find(m => m.id === id);
		setModelId(id);
		setOpen(false);
		onSelect?.(id, selected?.provider);
		if (sessionId) {
			void rpc.request("session.setModel", { sessionId, model: { id } }).catch(() => {});
		}
	};

	return (
		<div className="gui-model" ref={anchorRef}>
			<button
				type="button"
				className="gui-model-btn"
				onClick={() => setOpen(v => !v)}
				title={current ? `${current.provider}/${current.id}` : t("model")}
				aria-label={t("select model")}
			>
				<Icon name="ai-agent" className="h-3.5 w-3.5" />
				<span className="max-w-[150px] truncate">{label}</span>
				<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
			</button>
			{renderMenu(
				<div className="gui-model-menu">
					<div className="gui-model-menu-search">
						<Icon name="search" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder={t("search models…")}
							className="gui-model-menu-input"
							aria-label={t("search models…")}
						/>
					</div>
					{filtered.length === 0 && <div className="gui-model-empty">{t("no matching models")}</div>}
					{filtered.map(m => (
						<button
							key={m.id}
							type="button"
							className={`gui-model-opt${m.id === modelId ? " gui-model-opt--active" : ""}`}
							onClick={() => select(m.id)}
						>
							<span className="flex min-w-0 flex-1 items-center gap-2">
								<span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
								<span className="gui-provider-chip">{m.provider}</span>
							</span>
							{m.id === modelId && <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />}
						</button>
					))}
				</div>,
			)}
		</div>
	);
}
