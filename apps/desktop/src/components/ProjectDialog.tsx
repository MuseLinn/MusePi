import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickDirectory } from "../lib/electron";
import { pathBaseName } from "../lib/project-label";
import type { RpcClient } from "../lib/rpc";
import {
	createProject,
	directoriesEqual,
	setProjectPrimary,
	updateProject,
	type WorkspaceMutationResult,
} from "../lib/workspace-projects";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { DirectoryListEditor } from "./DirectoryListEditor";

export interface ProjectDialogTarget {
	/** Present in edit mode; omitted for a project that is not registered yet. */
	id?: string;
	root: string;
	name: string;
	additionalDirs: readonly string[];
}

const MAX_NAME = 100;
const MAX_DIRECTORIES = 64;

function sameDirectories(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((dir, index) => directoriesEqual(dir, right[index] ?? ""));
}

/**
 * Create/edit a workspace project in one modal: name, primary root and the
 * additional source directories new sessions inherit.
 *
 * Create and edit share the body so the two entry points cannot drift. In edit
 * mode a primary swap is staged locally and committed with `workspace.setPrimary`
 * before the name/directory update, keeping the daemon's atomic swap semantics.
 */
export function ProjectDialog({
	open,
	mode,
	target,
	rpc,
	onClose,
	onSaved,
}: {
	open: boolean;
	mode: "create" | "edit";
	target: ProjectDialogTarget | null;
	rpc: RpcClient | null;
	onClose(): void;
	onSaved(result: WorkspaceMutationResult): void;
}): ReactNode {
	const [name, setName] = useState("");
	const [primary, setPrimary] = useState("");
	const [additional, setAdditional] = useState<string[]>([]);
	const [missing, setMissing] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A fast double click can fire twice before the disabled button re-renders;
	// the ref makes the first save authoritative.
	const savingRef = useRef(false);
	// The primary picker fills the name from the folder until the user types.
	const nameTouched = useRef(false);

	const targetKey = target
		? `${mode}:${target.id ?? ""}:${target.root}:${target.name}:${target.additionalDirs.join("\n")}`
		: "";

	useEffect(() => {
		if (!open || !target) return;
		setName(target.name);
		setPrimary(target.root);
		setAdditional([...target.additionalDirs]);
		setMissing(new Set());
		setBusy(false);
		setError(null);
		nameTouched.current = false;
		if (mode !== "edit" || !rpc) return;
		let cancelled = false;
		void Promise.all(
			[target.root, ...target.additionalDirs].map(async directory => {
				const stat = await rpc.request<{ exists?: boolean }>("fs.stat", { path: directory }).catch(() => null);
				return stat?.exists === false ? directory : null;
			}),
		).then(rows => {
			if (!cancelled) setMissing(new Set(rows.filter((row): row is string => row !== null)));
		});
		return () => {
			cancelled = true;
		};
		// `targetKey` folds the target's mutable fields into one stable string.
	}, [open, mode, targetKey, rpc]);

	const initial = useMemo(
		() => ({
			root: target?.root ?? "",
			name: target?.name ?? "",
			additionalDirs: target?.additionalDirs ?? [],
		}),
		[targetKey],
	);

	const trimmedName = name.trim();
	const nameInvalid = trimmedName.length === 0 || trimmedName.length > MAX_NAME;
	const blockedByMissing = [...missing].some(directory =>
		additional.some(existing => directoriesEqual(existing, directory)),
	);
	const dirty =
		trimmedName !== initial.name ||
		!directoriesEqual(primary, initial.root) ||
		!sameDirectories(additional, initial.additionalDirs);
	const canSave =
		rpc !== null &&
		!busy &&
		!nameInvalid &&
		primary.length > 0 &&
		!blockedByMissing &&
		additional.length <= MAX_DIRECTORIES &&
		(mode === "create" || dirty);

	const choosePrimary = async (): Promise<void> => {
		const picked = (await pickDirectory())?.trim();
		if (!picked) return;
		setError(null);
		setPrimary(picked);
		setAdditional(current => current.filter(directory => !directoriesEqual(directory, picked)));
		if (!nameTouched.current) setName(pathBaseName(picked));
	};

	const save = async (): Promise<void> => {
		if (!rpc || !canSave || savingRef.current) return;
		savingRef.current = true;
		setBusy(true);
		setError(null);
		try {
			if (mode === "create") {
				const result = await createProject(rpc, primary, trimmedName, additional);
				onSaved(result);
				onClose();
				return;
			}
			if (!target?.id) throw new Error(t("projectDialog.missingProjectId"));
			if (!directoriesEqual(primary, initial.root)) {
				await setProjectPrimary(rpc, target.id, primary);
			}
			const result = await updateProject(rpc, target.id, {
				...(trimmedName === initial.name ? {} : { name: trimmedName }),
				additionalDirs: additional,
			});
			onSaved(result);
			onClose();
		} catch (failure) {
			const detail = failure instanceof Error && failure.message ? `: ${failure.message}` : "";
			setError(`${t(mode === "create" ? "projectDialog.createFailed" : "projectDialog.saveFailed")}${detail}`);
		} finally {
			savingRef.current = false;
			setBusy(false);
		}
	};

	return (
		<DialogFrame
			open={open}
			onClose={() => {
				if (!busy) onClose();
			}}
			label={t(mode === "create" ? "projectDialog.createTitle" : "projectDialog.editTitle")}
			className="gui-project-dialog"
		>
			<div className="gui-project-dialog-body">
				<div className="gui-new-project-field">
					<div className="gui-new-project-label">
						{t("settings.projectName")} <span className="gui-new-project-req">*</span>
					</div>
					<input
						className="gui-input w-full"
						value={name}
						placeholder={t("settings.projectNamePlaceholder")}
						autoFocus
						spellCheck={false}
						disabled={busy}
						onChange={event => {
							nameTouched.current = true;
							setName(event.target.value);
							setError(null);
						}}
						onKeyDown={event => {
							if (event.key === "Enter" && canSave) void save();
						}}
					/>
				</div>

				{mode === "create" && (
					<div className="gui-new-project-field">
						<div className="gui-new-project-label">
							{t("projectDialog.primaryDirectory")} <span className="gui-new-project-req">*</span>
						</div>
						<button
							type="button"
							className="gui-new-project-path"
							disabled={busy}
							onClick={() => void choosePrimary()}
						>
							<Icon name="folder" className="h-3.5 w-3.5 flex-none" />
							<span className="min-w-0 flex-1 truncate">{primary || t("projectDialog.choosePrimary")}</span>
							<Icon name="arrow-right-s" className="h-3 w-3 flex-none opacity-60" />
						</button>
					</div>
				)}

				<div className="gui-new-project-field">
					<div className="gui-project-dialog-heading">
						<span className="gui-new-project-label">{t("projectDialog.sourceFolders")}</span>
						{additional.length > 0 && <span className="gui-project-dialog-count">{additional.length}</span>}
					</div>
					<DirectoryListEditor
						primary={primary || undefined}
						directories={additional}
						missing={missing}
						disabled={busy}
						max={MAX_DIRECTORIES}
						emptyHint={primary ? t("projectDialog.sourceFoldersEmpty") : t("projectDialog.choosePrimaryFirst")}
						onChange={next => {
							setAdditional(next);
							setError(null);
						}}
						onPick={() => pickDirectory()}
						onSetPrimary={
							mode === "edit"
								? directory => {
										setAdditional(current => [
											primary,
											...current.filter(existing => !directoriesEqual(existing, directory)),
										]);
										setPrimary(directory);
										setError(null);
									}
								: undefined
						}
					/>
					<p className="gui-project-dialog-hint">{t("projectDialog.inheritHint")}</p>
				</div>

				{blockedByMissing && <p className="gui-project-dialog-error">{t("projectDialog.missingBlocksSave")}</p>}
				{error && (
					<p className="gui-project-dialog-error" role="alert">
						{error}
					</p>
				)}

				<div className="gui-project-dialog-footer">
					<button type="button" className="gui-btn" disabled={busy} onClick={onClose}>
						{t("settings.cancel")}
					</button>
					<button
						type="button"
						className="gui-btn gui-btn-primary"
						disabled={!canSave}
						onClick={() => void save()}
					>
						{busy ? t("settings.saving") : t(mode === "create" ? "projectDialog.create" : "projectDialog.save")}
					</button>
				</div>
			</div>
		</DialogFrame>
	);
}
