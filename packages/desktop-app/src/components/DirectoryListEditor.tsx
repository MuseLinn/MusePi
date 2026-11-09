import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useState } from "react";
import { pathBaseName } from "../lib/project-label";
import { directoriesEqual } from "../lib/workspace-projects";
import { Icon } from "../vendor/oc-icons";

/**
 * One workspace's directory rows: a fixed primary row (when `primary` is set)
 * plus editable additional directories.
 *
 * The editor is presentation-only — the caller owns persistence and the
 * native picker. That keeps the same row layout usable in the project dialog,
 * the session directory popover and the settings list, while each surface
 * decides what "save" means.
 */
export function DirectoryListEditor({
	primary,
	directories,
	missing,
	onChange,
	onPick,
	onSetPrimary,
	disabled = false,
	max,
	emptyHint,
	autoFocus = false,
}: {
	/** Primary root rendered first and never removable. Omit for list-only editors. */
	primary?: string;
	/** Additional directories; must not contain `primary`. */
	directories: readonly string[];
	/** Directories that no longer exist on disk, rendered as warnings. */
	missing?: ReadonlySet<string>;
	onChange(next: string[]): void;
	/** Resolve a directory through the host picker; null when cancelled. */
	onPick(): Promise<string | null> | string | null;
	/** Promote an additional directory to primary. Omit to hide the action. */
	onSetPrimary?(directory: string): void;
	disabled?: boolean;
	max?: number;
	emptyHint?: string;
	autoFocus?: boolean;
}): ReactNode {
	const [notice, setNotice] = useState<string | null>(null);
	const [picking, setPicking] = useState(false);
	const limitReached = max !== undefined && directories.length >= max;
	const busy = disabled || picking;

	const addDirectory = async (): Promise<void> => {
		if (busy || limitReached) return;
		setNotice(null);
		setPicking(true);
		try {
			const picked = await onPick();
			const directory = picked?.trim();
			if (!directory) return;
			if (primary !== undefined && directoriesEqual(directory, primary)) {
				setNotice(t("settings.directoryDuplicate", { path: directory }));
				return;
			}
			if (directories.some(existing => directoriesEqual(existing, directory))) {
				setNotice(t("settings.directoryDuplicate", { path: directory }));
				return;
			}
			onChange([...directories, directory]);
		} finally {
			setPicking(false);
		}
	};

	const removeDirectory = (directory: string): void => {
		setNotice(null);
		onChange(directories.filter(existing => !directoriesEqual(existing, directory)));
	};

	const directoryRow = (directory: string, options: { primary: boolean }): ReactNode => {
		const absent = missing?.has(directory) === true;
		return (
			<div
				key={`${options.primary ? "primary" : "extra"}:${directory}`}
				className={`gui-directory-row${absent ? " gui-directory-row--missing" : ""}`}
			>
				<Icon
					name={absent ? "error-warning" : options.primary ? "folder" : "folder-add"}
					className="gui-directory-row-icon"
				/>
				<div className="gui-directory-row-copy">
					<span className="gui-directory-row-name">{pathBaseName(directory)}</span>
					<span className="gui-directory-row-path" title={directory}>
						{directory}
					</span>
				</div>
				{absent ? (
					<span className="gui-directory-row-status">{t("settings.directoryMissing")}</span>
				) : options.primary ? (
					<span className="gui-directory-row-pill">{t("settings.primaryDirectory")}</span>
				) : null}
				{!options.primary && (
					<div className="gui-directory-row-actions">
						{onSetPrimary && !absent && (
							<button
								type="button"
								className="gui-pane-action w-auto px-1.5 text-[11px]"
								disabled={busy}
								onClick={() => {
									setNotice(null);
									onSetPrimary(directory);
								}}
							>
								{t("settings.setAsPrimary")}
							</button>
						)}
						<button
							type="button"
							className="gui-directory-row-remove"
							title={t("settings.removeDirectory")}
							aria-label={t("settings.removeDirectory")}
							disabled={busy}
							onClick={() => removeDirectory(directory)}
						>
							<Icon name="delete-bin" className="h-3.5 w-3.5" />
						</button>
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="gui-directory-editor">
			{primary !== undefined && directoryRow(primary, { primary: true })}
			{directories.map(directory => directoryRow(directory, { primary: false }))}
			{primary === undefined && directories.length === 0 && emptyHint !== undefined && (
				<p className="gui-directory-empty">{emptyHint}</p>
			)}
			<div className="gui-directory-editor-footer">
				<button
					type="button"
					className="gui-pane-action w-auto"
					disabled={busy || limitReached}
					onClick={() => void addDirectory()}
					autoFocus={autoFocus}
				>
					<Icon name="add-circle" className="h-3.5 w-3.5" />
					<span>{t("settings.addDirectory")}</span>
				</button>
				{limitReached && (
					<span className="gui-directory-limit">{t("settings.directoryLimit", { count: max ?? 0 })}</span>
				)}
			</div>
			{notice && (
				<p className="gui-directory-notice" role="status">
					{notice}
				</p>
			)}
		</div>
	);
}
