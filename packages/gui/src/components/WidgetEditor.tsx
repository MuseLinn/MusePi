import { t } from "@musepi/desktop-web/src/i18n/index.js";
import { GuiSelect } from "./GuiSelect";
import { WIDGET_REGISTRY, type WidgetField, widgetDef } from "@musepi/desktop-web/src/widgets/registry";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Board edit panel (kimi 修改 parity): opens from the header 编辑 button.
 * Clicking a card selects it; the panel edits the selected widget's title
 * and schema-driven data fields, shows its size/tone, deletes it, and
 * offers the add-widget list at the bottom (adding is usually agent work —
 * this is the manual fallback).
 */
export function WidgetEditor({
	boards,
	activeId,
	selectedId,
	onUpdate,
	onRename,
	onDelete,
	onAdd,
	onClose,
}: {
	boards: {
		id: string;
		widgets: {
			id: string;
			type: string;
			title: string;
			data: Record<string, unknown>;
			pos: { w: number; h: number };
		}[];
	}[];
	activeId: string;
	selectedId: string | null;
	onUpdate(id: string, patch: Record<string, unknown>): void;
	onRename(id: string, title: string): void;
	onDelete(id: string): void;
	onAdd(type: string): void;
	onClose(): void;
}): ReactNode {
	const [closing, setClosing] = useState(false);
	const handleClose = useCallback((): void => {
		setClosing(true);
		setTimeout(() => onClose(), 150);
	}, [onClose]);
	const active = boards.find(b => b.id === activeId);
	const widget = active?.widgets.find(w => w.id === selectedId) ?? null;
	const def = widget ? widgetDef(widget.type) : undefined;
	return (
		<div className={`gui-widget-editor${closing ? " gui-widget-editor--closing" : ""}`} role="dialog" aria-label={t("board edit")}>
			<div className="gui-widget-editor-head">
				<span className="gui-widget-editor-title">{t("board edit")}</span>
				<button type="button" className="gui-tool-btn" onClick={handleClose} aria-label={t("close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			{widget && def ? (
				<>
					<div className="gui-widget-editor-field">
						<span className="gui-widget-editor-label">{t("widget title")}</span>
						<input
							className="gui-task-input"
							value={widget.title}
							onChange={e => onRename(widget.id, e.target.value)}
						/>
					</div>
					<div className="gui-widget-editor-field">
						<span className="gui-widget-editor-label">
							{t("widget type")} · {widget.type}
						</span>
						<div className="gui-widget-editor-meta">
							<span>
								{widget.pos.w} × {widget.pos.h}px
							</span>
							<span>
								{t("widget tone")}: {def.tone ?? "default"}
							</span>
						</div>
					</div>
					{def.fields.map(field => (
						<FieldInput
							key={field.key}
							field={field}
							value={widget.data[field.key]}
							onChange={v => onUpdate(widget.id, { [field.key]: v })}
						/>
					))}
					{/* Live card-face preview: the REAL widget component renders with
					 * the current data (and tone), so every field edit reflects
					 * instantly — no static mock. */}
					<div className="gui-widget-editor-preview">
						<div className="gui-widget-editor-label">{t("widget preview")}</div>
						<div
							className="gui-widget-editor-preview-stage"
							data-tone={def.tone ?? "default"}
							style={{ aspectRatio: `${widget.pos.w} / ${widget.pos.h}` }}
						>
							<def.Component data={widget.data} update={() => {}} />
						</div>
					</div>
					<button type="button" className="gui-widget-editor-danger" onClick={() => onDelete(widget.id)}>
						<Icon name="delete-bin" className="h-3.5 w-3.5" />
						<span>{t("widget remove")}</span>
					</button>
				</>
			) : (
				<div className="gui-widget-editor-hint">{t("board edit hint")}</div>
			)}
			<div className="gui-widget-editor-add">
				<span className="gui-widget-editor-label">{t("board add widget")}</span>
				<div className="gui-widget-editor-add-list">
					{WIDGET_REGISTRY.map(w => (
						<button
							type="button"
							key={w.type}
							className="gui-widget-editor-add-btn"
							onClick={() => onAdd(w.type)}
						>
							{t(w.nameKey as never)}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function FieldInput({
	field,
	value,
	onChange,
}: {
	field: WidgetField;
	value: unknown;
	onChange(v: unknown): void;
}): ReactNode {
	const [num, setNum] = useState(typeof value === "number" ? String(value) : "");
	const label = field.label;
	if (field.type === "select") {
		return (
			<div className="gui-widget-editor-field">
				<span className="gui-widget-editor-label">{label}</span>
				<GuiSelect
					className="gui-settings-select"
					value={typeof value === "string" ? value : ""}
					onChange={v => onChange(v)}
					options={(field.options ?? []).map(o => ({ value: o, label: o }))}
				/>
			</div>
		);
	}
	if (field.type === "number") {
		return (
			<div className="gui-widget-editor-field">
				<span className="gui-widget-editor-label">{label}</span>
				<input
					className="gui-task-input"
					type="number"
					step={field.step ?? 1}
					min={field.min}
					max={field.max}
					value={num}
					placeholder={typeof value === "number" ? String(value) : ""}
					onChange={e => {
						setNum(e.target.value);
						const n = Number(e.target.value);
						if (!Number.isNaN(n)) onChange(n);
					}}
				/>
			</div>
		);
	}
	const str = typeof value === "string" ? value : "";
	// Long text fields (custom html faces, prompt-like data) get a
	// textarea instead of a single-line input.
	if (str.length > 120) {
		return (
			<div className="gui-widget-editor-field">
				<span className="gui-widget-editor-label">{label}</span>
				<textarea
					className="gui-task-input gui-widget-editor-textarea"
					rows={8}
					value={str}
					onChange={e => onChange(e.target.value)}
				/>
			</div>
		);
	}
	return (
		<div className="gui-widget-editor-field">
			<span className="gui-widget-editor-label">{label}</span>
			<input className="gui-task-input" value={str} onChange={e => onChange(e.target.value)} />
		</div>
	);
}
