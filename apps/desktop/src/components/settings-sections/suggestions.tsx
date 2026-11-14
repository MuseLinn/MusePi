import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { t } from "@musepi/client-core";
import { type ReactNode, useState } from "react";
import { restrictToYAxis } from "../../lib/dnd-axis";
import {
	loadUserSuggestions,
	resetSuggestions,
	resolveSuggestion,
	type StoredSuggestion,
	saveSuggestions,
} from "../../lib/suggestions";
import { Icon } from "../../vendor/oc-icons";

/**
 * 预设提示词 (openchamber DraftPresetChips parity): manages the quick
 * prompts under the empty-state composer.
 *
 * Rows reorder by the same drag gesture as the right-panel tabs (dnd-kit:
 * grab the handle, the row lifts, slots open live; keyboard: focus the
 * handle, Space to lift, ↑/↓ to move, Space to drop). Built-in entries stay
 * i18n-keyed until edited — editing one converts it to a literal custom entry.
 * Changes persist to localStorage and broadcast live to the welcome composer.
 */
export function PromptsSection(): ReactNode {
	const [items, setItems] = useState<StoredSuggestion[]>(() => loadUserSuggestions());
	// Inline editor state: editing[index] replaces that row; adding appends.
	const [editing, setEditing] = useState<{ index: number; label: string; prompt: string } | null>(null);
	const [adding, setAdding] = useState<{ label: string; prompt: string } | null>(null);
	const busy = editing !== null || adding !== null;

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
		const next = [...items];
		next[editing.index] = { label: editing.label.trim(), prompt: editing.prompt.trim() };
		commit(next);
		setEditing(null);
	};

	const saveAdd = (): void => {
		if (!adding) return;
		commit([...items, { label: adding.label.trim(), prompt: adding.prompt.trim() }]);
		setAdding(null);
	};

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const onDragEnd = (event: DragEndEvent): void => {
		const from = Number(event.active.id);
		const to = event.over ? Number(event.over.id) : Number.NaN;
		if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
		commit(arrayMove(items, from, to));
	};

	return (
		<>
			<div className="gui-settings-page-title">{t("settings.starterPrompts")}</div>
			<p className="gui-settings-page-desc">{t("settings.starterPromptsHint")}</p>
			<div className="gui-settings-section">
				<div className="gui-suggest-head">
					<button
						type="button"
						className="gui-link gui-suggest-reset"
						onClick={() => {
							resetSuggestions();
							setItems(loadUserSuggestions());
							setEditing(null);
							setAdding(null);
						}}
					>
						{t("general.resetDefaults")}
					</button>
				</div>
				{items.length === 0 && !adding && <p className="gui-suggest-empty">{t("general.noPromptsYet")}</p>}
				{items.length > 0 && (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={[restrictToYAxis]}
						onDragEnd={onDragEnd}
					>
						<SortableContext items={items.map((_, index) => index)} strategy={verticalListSortingStrategy}>
							<div className="gui-suggest-list">
								{items.map((item, index) =>
									editing?.index === index ? (
										<PromptEditor
											key={`edit:${index}`}
											value={editing}
											onChange={next => setEditing({ index, ...next })}
											onSave={saveEdit}
											onCancel={() => setEditing(null)}
										/>
									) : (
										<SortablePromptRow
											key={`row:${index}`}
											index={index}
											item={item}
											disabled={busy}
											onEdit={() => startEdit(index)}
											onRemove={() => remove(index)}
										/>
									),
								)}
							</div>
						</SortableContext>
					</DndContext>
				)}
				{adding && (
					<PromptEditor
						value={adding}
						autoFocus
						onChange={setAdding}
						onSave={saveAdd}
						onCancel={() => setAdding(null)}
					/>
				)}
				<button
					type="button"
					className="gui-suggest-add"
					disabled={adding !== null}
					onClick={() => setAdding({ label: "", prompt: "" })}
				>
					<Icon name="add-circle" className="h-4 w-4" />
					<span>{t("general.addSuggestion")}</span>
				</button>
			</div>
		</>
	);
}

/** One prompt row: handle, label + built-in tag, prompt preview, and actions
 *  that appear on hover/focus so the list reads as prompts, not buttons. */
function SortablePromptRow({
	index,
	item,
	disabled,
	onEdit,
	onRemove,
}: {
	index: number;
	item: StoredSuggestion;
	disabled: boolean;
	onEdit(): void;
	onRemove(): void;
}): ReactNode {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id: index,
		disabled,
	});
	const resolved = resolveSuggestion(item);
	return (
		<div
			ref={setNodeRef}
			className={`gui-suggest-row${isDragging ? " gui-suggest-row--dragging" : ""}`}
			style={transform ? { transform: CSS.Transform.toString(transform), transition } : undefined}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				className="gui-suggest-grip"
				{...attributes}
				{...listeners}
				disabled={disabled}
				title={t("settings.dragReorder")}
				aria-label={t("settings.dragReorder")}
			>
				<Icon name="draggable" className="h-3.5 w-3.5" />
			</button>
			<div className="gui-suggest-row-body">
				<div className="gui-suggest-row-title">
					<span className="gui-suggest-row-label">{resolved.label}</span>
					{resolved.builtin && <span className="gui-suggest-badge">{t("general.builtin")}</span>}
				</div>
				<div className="gui-suggest-row-prompt" title={resolved.prompt}>
					{resolved.prompt}
				</div>
			</div>
			<div className="gui-suggest-row-actions">
				<button
					type="button"
					className="gui-suggest-action"
					title={t("settings.edit")}
					aria-label={t("settings.edit")}
					disabled={disabled}
					onClick={onEdit}
				>
					<Icon name="pencil" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-suggest-action gui-suggest-action--danger"
					title={t("general.remove")}
					aria-label={t("general.remove")}
					disabled={disabled}
					onClick={onRemove}
				>
					<Icon name="delete-bin" className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}

/** Inline editor card: label on one line, the prompt in a textarea — a full
 *  sentence does not fit the old single-line pair of inputs. */
function PromptEditor({
	value,
	autoFocus = false,
	onChange,
	onSave,
	onCancel,
}: {
	value: { label: string; prompt: string };
	autoFocus?: boolean;
	onChange(next: { label: string; prompt: string }): void;
	onSave(): void;
	onCancel(): void;
}): ReactNode {
	const ready = value.label.trim() !== "" && value.prompt.trim() !== "";
	return (
		<div className="gui-suggest-editor">
			<input
				className="gui-input"
				value={value.label}
				placeholder={t("general.suggestionLabel")}
				aria-label={t("general.suggestionLabel")}
				autoFocus={autoFocus}
				onChange={event => onChange({ ...value, label: event.target.value })}
			/>
			<textarea
				className="gui-input gui-suggest-editor-prompt"
				rows={3}
				value={value.prompt}
				placeholder={t("general.suggestionPrompt")}
				aria-label={t("general.suggestionPrompt")}
				onChange={event => onChange({ ...value, prompt: event.target.value })}
			/>
			<div className="gui-suggest-editor-actions">
				<button type="button" className="gui-btn" onClick={onCancel}>
					{t("settings.cancel")}
				</button>
				<button type="button" className="gui-btn gui-btn-approve" disabled={!ready} onClick={onSave}>
					{t("general.save")}
				</button>
			</div>
		</div>
	);
}
