import { t } from "@musepi/desktop-web";
import { type ReactNode, useRef, useState } from "react";
import {
	loadUserSuggestions,
	resetSuggestions,
	resolveSuggestion,
	type StoredSuggestion,
	saveSuggestions,
} from "../../lib/suggestions";
import { usePointerDrag } from "../../lib/use-pointer-drag";
import { Icon } from "../../vendor/oc-icons";

/**
 * 预设提示词 (openchamber DraftPresetChips parity): manages the quick
 * prompts under the empty-state composer. Add / edit / remove, reorder by
 * POINTER DRAG (unified usePointerDrag primitive — no more ↑↓ buttons).
 * Built-in entries stay i18n-keyed (localized at render) until edited —
 * editing one converts it to a literal custom entry. Changes persist to
 * localStorage and broadcast live to the welcome composer.
 */
export function PromptsSection(): ReactNode {
	const [items, setItems] = useState<StoredSuggestion[]>(() => loadUserSuggestions());
	// Inline editor state: editing[index] (custom rows only) / adding (append).
	const [editing, setEditing] = useState<{ index: number; label: string; prompt: string } | null>(null);
	const [adding, setAdding] = useState<{ label: string; prompt: string } | null>(null);

	const commit = (next: StoredSuggestion[]): void => {
		setItems(next);
		saveSuggestions(next);
	};

	const remove = (index: number): void => {
		commit(items.filter((_, i) => i !== index));
	};

	// Editing a builtin converts it to a custom entry (prefilled with the
	// current localized text) so the user's literal text sticks.
	const startEdit = (index: number): void => {
		const r = resolveSuggestion(items[index]!);
		setEditing({ index, label: r.label, prompt: r.prompt });
	};

	const saveEdit = (): void => {
		if (!editing) return;
		const label = editing.label.trim();
		const prompt = editing.prompt.trim();
		if (!label || !prompt) return;
		const next = [...items];
		next[editing.index] = { label, prompt };
		commit(next);
		setEditing(null);
	};

	const saveAdd = (): void => {
		if (!adding) return;
		const label = adding.label.trim();
		const prompt = adding.prompt.trim();
		if (!label || !prompt) return;
		commit([...items, { label, prompt }]);
		setAdding(null);
	};

	// ── Pointer-drag reorder (usePointerDrag) ────────────────────────────
	// Rows carry data-suggest-row; the hook's captured pointermove/up run
	// outside the row, so the over-target is resolved from
	// elementsFromPoint each move. The preview order re-renders live;
	// the commit happens once on drop. Row pointerdown records the start
	// index (buttons inside stop propagation so they never start a drag).
	const dragRowRef = useRef(-1);
	const [dragState, setDragState] = useState<{ item: StoredSuggestion; from: number; over: number } | null>(null);
	const dragHandlers = usePointerDrag({
		onDragStart: () => {
			const from = dragRowRef.current;
			if (from < 0 || from >= items.length) return;
			setDragState({ item: items[from]!, from, over: from });
		},
		onDragMove: ({ x, y }) => {
			if (!dragState) return;
			const el = document
				.elementsFromPoint(x, y)
				.find(node => node instanceof HTMLElement && node.hasAttribute("data-suggest-row"));
			const over = el instanceof HTMLElement ? Number(el.getAttribute("data-suggest-row")) : -1;
			if (Number.isInteger(over) && over >= 0 && over < items.length && over !== dragState.over) {
				setDragState(s => (s ? { ...s, over } : s));
			}
		},
		onDragEnd: ({ dragged }) => {
			const s = dragState;
			setDragState(null);
			if (dragged && s && s.from !== s.over) {
				const next = [...items];
				const [item] = next.splice(s.from, 1);
				next.splice(s.over, 0, item!);
				commit(next);
			}
		},
	});
	// Live preview order while dragging (stable commit happens on drop).
	const displayed = (() => {
		if (!dragState || dragState.from === dragState.over) return items;
		const next = [...items];
		const [item] = next.splice(dragState.from, 1);
		next.splice(dragState.over, 0, item!);
		return next;
	})();
	const activeDragItem = dragState?.item ?? null;

	return (
		<>
			<div className="gui-settings-page-title">{t("starter prompts")}</div>
			<p className="gui-settings-page-desc">{t("starter prompts hint")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("starter prompts")}</div>
				{items.length === 0 ? (
					<div className="text-[13px] text-[var(--color-text-faint)]">{t("no prompts yet")}</div>
				) : (
					displayed.map((s, i) => {
						if (editing?.index === i) {
							return (
								<div key={i} className="gui-settings-row">
									<input
										className="gui-input min-w-0 flex-1"
										value={editing.label}
										placeholder={t("suggestion label")}
										onChange={e => setEditing({ ...editing, label: e.target.value })}
									/>
									<input
										className="gui-input min-w-0 flex-1"
										value={editing.prompt}
										placeholder={t("suggestion prompt")}
										onChange={e => setEditing({ ...editing, prompt: e.target.value })}
									/>
									<button
										type="button"
										className="gui-btn gui-btn-approve"
										disabled={!editing.label.trim() || !editing.prompt.trim()}
										onClick={saveEdit}
									>
										{t("save")}
									</button>
									<button type="button" className="gui-btn" onClick={() => setEditing(null)}>
										{t("cancel")}
									</button>
								</div>
							);
						}
						const r = resolveSuggestion(s);
						const dragging = s === activeDragItem;
						return (
							<div
								key={i}
								className={`gui-settings-row gui-suggest-drag-row${dragging ? " gui-suggest-drag-row--active" : ""}`}
								data-suggest-row={i}
								style={{ touchAction: "none" }}
								onPointerDown={e => {
									if (editing || adding) return;
									dragRowRef.current = i;
									dragHandlers.onPointerDown(e);
								}}
								onPointerMove={dragHandlers.onPointerMove}
								onPointerUp={dragHandlers.onPointerUp}
								onPointerCancel={dragHandlers.onPointerCancel}
							>
								<span className="gui-suggest-drag-grip" aria-hidden="true">
									<Icon name="draggable" className="h-3.5 w-3.5" />
								</span>
								<div className="min-w-0 flex-1">
									<div className="gui-settings-row-label">
										{r.label}
										{r.builtin && <span className="gui-suggest-badge">{t("builtin")}</span>}
									</div>
									<div className="truncate text-[12px] text-[var(--color-text-faint)]">{r.prompt}</div>
								</div>
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									title={t("edit")}
									aria-label={t("edit")}
									onPointerDown={e => e.stopPropagation()}
									onClick={() => startEdit(i)}
								>
									<Icon name="pencil" className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									title={t("remove")}
									aria-label={t("remove")}
									onPointerDown={e => e.stopPropagation()}
									onClick={() => remove(i)}
								>
									<Icon name="delete-bin" className="h-3.5 w-3.5" />
								</button>
							</div>
						);
					})
				)}
				{adding && (
					<div className="gui-settings-row">
						<input
							className="gui-input min-w-0 flex-1"
							value={adding.label}
							placeholder={t("suggestion label")}
							autoFocus
							onChange={e => setAdding({ ...adding, label: e.target.value })}
						/>
						<input
							className="gui-input min-w-0 flex-1"
							value={adding.prompt}
							placeholder={t("suggestion prompt")}
							onChange={e => setAdding({ ...adding, prompt: e.target.value })}
						/>
						<button
							type="button"
							className="gui-btn gui-btn-approve"
							disabled={!adding.label.trim() || !adding.prompt.trim()}
							onClick={saveAdd}
						>
							{t("save")}
						</button>
						<button type="button" className="gui-btn" onClick={() => setAdding(null)}>
							{t("cancel")}
						</button>
					</div>
				)}
				<div className="gui-suggest-manage-actions">
					<button type="button" className="gui-btn" onClick={() => setAdding({ label: "", prompt: "" })}>
						<Icon name="add-circle" className="h-3.5 w-3.5" />
						<span>{t("add suggestion")}</span>
					</button>
					<button
						type="button"
						className="gui-btn"
						onClick={() => {
							resetSuggestions();
							setItems(loadUserSuggestions());
							setEditing(null);
							setAdding(null);
							setDragState(null);
						}}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						<span>{t("reset to defaults")}</span>
					</button>
				</div>
			</div>
		</>
	);
}
