import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { makeProjectActionId, type ProjectAction, resolveProjectActionIcon } from "../lib/project-actions";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";

/**
 * Editor for the header project-actions menu (openchamber
 * ProjectActionsSection parity, scoped to localStorage): lists the
 * project's custom actions (rename / retype command / delete) plus an
 * add-or-edit form at the bottom. The parent keeps the dialog mounted and
 * drives it with `open` — the DialogFrame owns the exit animation.
 */
export function ProjectActionsDialog({
	open,
	onClose,
	actions,
	onChange,
}: {
	open: boolean;
	onClose(): void;
	actions: ProjectAction[];
	onChange(actions: ProjectAction[]): void;
}): ReactNode {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");

	// Reset the draft when the dialog closes (after the exit animation).
	useEffect(() => {
		if (!open) {
			setEditingId(null);
			setName("");
			setCommand("");
		}
	}, [open]);

	const resetDraft = (): void => {
		setEditingId(null);
		setName("");
		setCommand("");
	};

	const startEdit = (action: ProjectAction): void => {
		setEditingId(action.id);
		setName(action.name);
		setCommand(action.command);
	};

	const saveDraft = (): void => {
		const nextName = name.trim();
		const nextCommand = command.trim();
		if (!nextName || !nextCommand) return;
		if (editingId) {
			onChange(actions.map(a => (a.id === editingId ? { ...a, name: nextName, command: nextCommand } : a)));
		} else {
			onChange([...actions, { id: makeProjectActionId(), name: nextName, command: nextCommand, icon: "play" }]);
		}
		resetDraft();
	};

	const removeAction = (id: string): void => {
		onChange(actions.filter(a => a.id !== id));
		if (editingId === id) resetDraft();
	};

	return (
		<DialogFrame open={open} onClose={onClose} label={t("edit project actions")} className="w-[460px] max-w-[92vw]">
			<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
				<h3 className="text-[14px] font-semibold text-[var(--color-text)]">{t("edit project actions")}</h3>
				{actions.length === 0 ? (
					<div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-[var(--color-text-faint)]">
						{t("no custom actions")}
					</div>
				) : (
					<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
						{actions.map(action => (
							<div
								key={action.id}
								className={`group flex items-center gap-2 rounded-lg px-2 py-1.5${
									editingId === action.id
										? " bg-[var(--color-surface-sunken)]"
										: " hover:bg-[var(--color-surface-sunken)]"
								}`}
							>
								<Icon
									name={resolveProjectActionIcon(action.icon)}
									className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-text-faint)]"
								/>
								<div className="min-w-0 flex-1">
									<div className="truncate text-[13px] text-[var(--color-text)]">{action.name}</div>
									<div className="truncate font-mono text-[11px] text-[var(--color-text-faint)]">
										{action.command}
									</div>
								</div>
								<button
									type="button"
									className="gui-view-opt !w-auto px-1.5"
									title={t("edit action")}
									aria-label={t("edit action")}
									onClick={() => startEdit(action)}
								>
									<Icon name="pencil" className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									className="gui-view-opt gui-view-opt--danger !w-auto px-1.5"
									title={t("delete action")}
									aria-label={t("delete action")}
									onClick={() => removeAction(action.id)}
								>
									<Icon name="delete-bin" className="h-3.5 w-3.5" />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="flex flex-col gap-1.5 border-t border-[var(--border)] pt-3">
					<div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)]">
						{editingId ? t("edit action") : t("add action")}
					</div>
					<input
						className="gui-input w-full"
						placeholder={t("action name")}
						value={name}
						onChange={e => setName(e.target.value)}
					/>
					<input
						className="gui-input w-full font-mono"
						placeholder={t("action command")}
						value={command}
						onChange={e => setCommand(e.target.value)}
					/>
					<div className="flex gap-1.5">
						<button
							type="button"
							className="gui-btn gui-btn-primary gui-btn-sm flex-1"
							disabled={!name.trim() || !command.trim()}
							onClick={saveDraft}
						>
							{editingId ? t("save") : t("add")}
						</button>
						{editingId && (
							<button type="button" className="gui-btn gui-btn-sm" onClick={resetDraft}>
								{t("cancel")}
							</button>
						)}
					</div>
				</div>
			</div>
		</DialogFrame>
	);
}
