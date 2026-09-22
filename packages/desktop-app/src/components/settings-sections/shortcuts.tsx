import { t, tLoose } from "@musepi/client-core";
import { Pencil, Search, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	bindingLabel,
	isOverridden,
	normalizeEvent,
	SHORTCUTS,
	SHORTCUTS_CHANGED_EVENT,
	type ShortcutEntry,
	setBinding,
} from "../../lib/shortcut-registry";

/**
 * 设置 → 快捷键 (kimicode parity): searchable list where every row is
 * action name + one-line description + binding chips + edit/reset. Edit
 * arms a capture-the-next-press mode; conflicts are refused with the name
 * of the owning action. Overrides persist via the shortcut registry and
 * the window handlers read the same source, so a rebind takes effect
 * immediately — the old static table could only describe the hardcoded
 * chain in app.tsx.
 */
export function ShortcutsSection(): ReactNode {
	const [query, setQuery] = useState("");
	const [capturing, setCapturing] = useState<string | null>(null);
	const [conflict, setConflict] = useState<{ id: string; label: string } | null>(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		const onChanged = (): void => setTick(v => v + 1);
		window.addEventListener(SHORTCUTS_CHANGED_EVENT, onChanged);
		return () => window.removeEventListener(SHORTCUTS_CHANGED_EVENT, onChanged);
	}, []);

	// Capture mode: the next keydown anywhere becomes the binding (Esc
	// cancels). Registered on window while capturing — the settings view
	// has no text fields that would fight over ordinary keys.
	useEffect(() => {
		if (capturing === null) return;
		const onKey = (e: KeyboardEvent): void => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setCapturing(null);
				return;
			}
			const binding = normalizeEvent(e);
			if (binding === null) return;
			const res = setBinding(capturing, binding);
			if (!res.ok && res.conflict) {
				const owner = SHORTCUTS.find(s => s.id === res.conflict);
				setConflict({ id: capturing, label: owner ? tLoose(owner.labelKey) : res.conflict });
			} else {
				setConflict(null);
				setCapturing(null);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [capturing]);

	const rows = useMemo(() => {
		void tick;
		const q = query.trim().toLowerCase();
		if (q === "") return SHORTCUTS;
		return SHORTCUTS.filter(s => {
			const hay = `${tLoose(s.labelKey)} ${tLoose(s.descKey)} ${bindingLabel(s.id)}`.toLowerCase();
			return hay.includes(q);
		});
	}, [query, tick]);

	const groups = useMemo(() => {
		const out: { key: string; items: ShortcutEntry[] }[] = [];
		for (const row of rows) {
			const key = row.groupKey ?? "";
			const last = out[out.length - 1];
			if (last && last.key === key) last.items.push(row);
			else out.push({ key, items: [row] });
		}
		return out;
	}, [rows]);

	return (
		<>
			<h2 className="gui-settings-page-title">{t("shortcuts")}</h2>
			<p className="gui-settings-page-desc">{t("shortcuts settings")}</p>
			<div className="gui-sc-search">
				<Search size={13} className="gui-sc-search-ico" />
				<input
					className="gui-sc-search-input"
					placeholder={tLoose("shortcut search placeholder")}
					value={query}
					onChange={e => setQuery(e.target.value)}
				/>
			</div>
			{conflict && (
				<p className="gui-sc-conflict" role="alert">
					{tLoose("shortcut conflict", { label: conflict.label })}
				</p>
			)}
			<div className="gui-sc-list">
				{groups.map(g => (
					<div key={g.key || "all"} className="gui-sc-group">
						{g.key !== "" && <div className="gui-sc-group-title">{tLoose(g.key)}</div>}
						{g.items.map(row => (
							<div key={row.id} className={`gui-sc-row${capturing === row.id ? " gui-sc-row--capturing" : ""}`}>
								<div className="gui-sc-row-text">
									<span className="gui-sc-row-name">
										{tLoose(row.labelKey)}
										{isOverridden(row.id) && (
											<em className="gui-sc-modified">{tLoose("shortcut modified")}</em>
										)}
									</span>
									<span className="gui-sc-row-desc">{tLoose(row.descKey)}</span>
								</div>
								<div className="gui-sc-row-keys">
									{capturing === row.id ? (
										<span className="gui-sc-capture">{tLoose("shortcut capture hint")}</span>
									) : (
										<kbd className="gui-kbd">{bindingLabel(row.id)}</kbd>
									)}
									{row.editable && capturing !== row.id && (
										<button
											type="button"
											className="gui-sc-btn"
											title={tLoose("shortcut edit")}
											aria-label={tLoose("shortcut edit")}
											onClick={() => {
												setConflict(null);
												setCapturing(row.id);
											}}
										>
											<Pencil size={12} />
										</button>
									)}
									{row.editable && isOverridden(row.id) && (
										<button
											type="button"
											className="gui-sc-btn"
											title={tLoose("shortcut reset")}
											aria-label={tLoose("shortcut reset")}
											onClick={() => setBinding(row.id, null)}
										>
											<Trash2 size={12} />
										</button>
									)}
								</div>
							</div>
						))}
					</div>
				))}
				{rows.length === 0 && <div className="gui-sc-empty">{query}</div>}
			</div>
		</>
	);
}
