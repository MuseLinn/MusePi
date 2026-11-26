import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";

/**
 * Pick a directory **on `rpc`'s machine**, not on this one.
 *
 * The project dialog used to call the OS directory picker, which returns a path
 * on the machine the window runs on. That is correct for a local daemon and
 * wrong for a remote one: the path is sent to the daemon in `workspace.create`
 * and resolved there, so a local pick produced a path the remote host never had
 * and the create failed with "not a directory" for a folder the user could see.
 *
 * `fs.list` answers from the daemon's own filesystem, so this picker is correct
 * on both: it browses whatever machine the daemon runs on. A host with the OS
 * dialog available still gets it from the caller — this dialog is the fallback
 * for the case where the picker and the daemon disagree.
 */
export interface RemotePathPickerProps {
	open: boolean;
	rpc: RpcClient | null;
	onClose(): void;
	onPick(path: string): void;
	/** Which machine the daemon runs on, for the header sentence. */
	hostLabel?: string;
}

interface Listed {
	path: string;
	parent: string | null;
	entries: Array<{ name: string; path: string; isDir: boolean }>;
	error?: string;
}

export function RemotePathPicker({ open, rpc, onClose, onPick, hostLabel }: RemotePathPickerProps): ReactNode {
	const [listed, setListed] = useState<Listed | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);

	const load = useCallback(
		async (path?: string): Promise<void> => {
			if (!rpc) return;
			setBusy(true);
			setError(null);
			try {
				const res = await rpc.request<Listed>("fs.list", path ? { path } : {});
				setListed(res);
				setSelected(res.path);
				if (res.error) setError(res.error);
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				setBusy(false);
			}
		},
		[rpc],
	);

	useEffect(() => {
		if (!open) return;
		setListed(null);
		setSelected(null);
		setError(null);
		void load();
	}, [open, load]);

	const dirs = (listed?.entries ?? []).filter(entry => entry.isDir);

	return (
		<DialogFrame open={open} onClose={onClose} label={t("projectDialog.browseOnHost")} className="gui-path-picker">
			<div className="gui-dialog-head">
				<span className="text-[15px] font-semibold">{t("projectDialog.browseOnHost")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			{/* Says which machine the list belongs to: the whole point of this
			 * dialog is that it is not this machine's filesystem. */}
			<p className="gui-path-picker-host">
				{hostLabel
					? t("projectDialog.pickingOnHost", { host: hostLabel })
					: t("projectDialog.pickingOnThisMachine")}
			</p>
			<div className="gui-path-picker-bar">
				<button
					type="button"
					className="gui-tool-btn"
					disabled={!listed?.parent || busy}
					title={t("settings.parentDirectory")}
					onClick={() => void load(listed?.parent ?? undefined)}
				>
					<Icon name="arrow-up" className="h-4 w-4" />
				</button>
				<span className="gui-path-picker-path" title={listed?.path ?? ""}>
					{listed?.path ?? ""}
				</span>
				<button
					type="button"
					className="gui-tool-btn"
					disabled={busy}
					title={t("settings.refresh")}
					onClick={() => void load(listed?.path)}
				>
					<Icon name="refresh" className="h-4 w-4" />
				</button>
			</div>
			{error && (
				<p className="gui-path-picker-error" role="alert">
					{error}
				</p>
			)}
			<ul className="gui-path-picker-list">
				{dirs.map(entry => (
					<li key={entry.path}>
						<button
							type="button"
							className="gui-path-picker-row"
							data-selected={selected === entry.path ? "true" : "false"}
							onClick={() => {
								setSelected(entry.path);
								void load(entry.path);
							}}
						>
							<Icon name="folder" className="h-4 w-4 flex-none text-[var(--color-accent)]" />
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
							{selected === entry.path && <Icon name="check" className="h-4 w-4 flex-none" />}
						</button>
					</li>
				))}
				{!busy && dirs.length === 0 && <li className="gui-path-picker-empty">∅</li>}
			</ul>
			<div className="gui-project-dialog-footer">
				<button type="button" className="gui-btn" onClick={onClose}>
					{t("settings.cancel")}
				</button>
				<button
					type="button"
					className="gui-btn gui-btn-primary"
					disabled={!selected || busy}
					onClick={() => {
						if (selected) onPick(selected);
						onClose();
					}}
				>
					{t("projectDialog.useThisFolder")}
				</button>
			</div>
		</DialogFrame>
	);
}
