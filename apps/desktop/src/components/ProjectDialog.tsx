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
import { RemotePathPicker } from "./RemotePathPicker";

export interface ProjectDialogTarget {
	/** Present in edit mode; omitted for a project that is not registered yet. */
	id?: string;
	root: string;
	name: string;
	additionalDirs: readonly string[];
}

/**
 * Where the project runs, as the create form asks it.
 *
 * A project's directory is resolved *on the daemon*, so "where does this
 * project run" is a real question at creation time and not only at connect
 * time: a folder chosen here must exist on that machine. The answer mirrors the
 * instance model's two axes — this computer / a remote host, and the host system
 * / a container / WSL — because the two surfaces describe the same machinery.
 *
 * `location` is the user's intent and is kept apart from the host string for
 * the same reason the instance form keeps theirs apart: picking 远程主机 before
 * typing a host must not flip the chip back.
 */
export interface ProjectLocationChoice {
	location: "local" | "remote";
	environment: "system" | "container" | "wsl";
	/** `user@host`, filled once 远程主机 is chosen. */
	host: string;
}

export const DEFAULT_PROJECT_LOCATION: ProjectLocationChoice = {
	location: "local",
	environment: "system",
	host: "",
};

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
	remoteHost,
	location: locationProp,
	onLocationChange,
	hosts = [],
	onCreate,
}: {
	open: boolean;
	mode: "create" | "edit";
	target: ProjectDialogTarget | null;
	rpc: RpcClient | null;
	onClose(): void;
	onSaved(result: WorkspaceMutationResult): void;
	/**
	 * The machine the daemon runs on, when it is not this one.
	 *
	 * `workspace.create` resolves `root` **on the daemon**, so the OS directory
	 * picker is only correct when the daemon is local. With a remote host the
	 * picker has to ask that machine (`fs.list`), otherwise the user selects a
	 * folder they can see here and the daemon fails on a path it never had.
	 */
	remoteHost?: string | null;
	/**
	 * Where this project runs, when the caller owns that choice.
	 *
	 * The shell owns it because switching the machine means switching the
	 * daemon, which is not this dialog's decision to make on its own; the dialog
	 * asks and reports. Absent, the form reads the machine from `remoteHost` and
	 * shows the axes as a statement rather than a control.
	 */
	location?: ProjectLocationChoice;
	onLocationChange?(next: ProjectLocationChoice): void;
	/** Instances the location chips can point at, newest first. */
	hosts?: readonly { id: string; label: string; host: string }[];
	/**
	 * Creates the project, when the caller owns which daemon receives it.
	 *
	 * `workspace.create` both registers the row and resolves `root` on the
	 * receiving daemon, so a project whose files live elsewhere has to be
	 * created there. The shell owns that decision (it is the one that can
	 * connect), so the dialog hands over the facts and takes the result.
	 * Absent, the dialog writes through its own `rpc`.
	 */
	onCreate?(input: {
		name: string;
		root: string;
		additionalDirs: readonly string[];
	}): Promise<WorkspaceMutationResult>;
}): ReactNode {
	const [name, setName] = useState("");
	const [primary, setPrimary] = useState("");
	const [additional, setAdditional] = useState<string[]>([]);
	const [missing, setMissing] = useState<Set<string>>(new Set());
	/** Which field the remote picker is filling: the primary root, or a source folder. */
	const [remotePick, setRemotePick] = useState<"primary" | "source" | null>(null);
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
	/** The machine the entry will be created on: the caller's choice, else the
	 *  daemon the shell is already talking to. */
	const effectiveHost = locationProp
		? locationProp.location === "remote"
			? locationProp.host.trim() || null
			: null
		: (remoteHost ?? null);
	const locationIncomplete = locationProp?.location === "remote" && !effectiveHost;
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
		!locationIncomplete &&
		!blockedByMissing &&
		additional.length <= MAX_DIRECTORIES &&
		(mode === "create" || dirty);

	const choosePrimary = async (): Promise<void> => {
		if (effectiveHost) {
			setRemotePick("primary");
			return;
		}
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
				const result = onCreate
					? await onCreate({ name: trimmedName, root: primary, additionalDirs: additional })
					: await createProject(rpc, primary, trimmedName, additional);
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

				{mode === "create" && locationProp && onLocationChange && (
					<>
						{/* Where the project runs. The chip pair is the same model the
						 * instance form asks, because a project's directory is resolved on
						 * that machine: choosing 容器 here means the daemon inside that
						 * container resolves the path, and the folder picker below has to
						 * ask the same machine. */}
						<div className="gui-new-project-field">
							<div className="gui-proj-axis">
								<span className="gui-proj-axis-label">{t("settings.instanceLocation")}</span>
								<div className="gui-conn-kinds" role="radiogroup" aria-label={t("settings.instanceLocation")}>
									{(["local", "remote"] as const).map(location => (
										<button
											key={location}
											type="button"
											role="radio"
											aria-checked={locationProp.location === location}
											disabled={busy}
											className="gui-conn-kind-btn"
											onClick={() =>
												onLocationChange({
													...locationProp,
													location,
													// WSL is a local Windows feature, so moving to a remote
													// host has nowhere to put it and falls back to the host.
													environment:
														location === "remote" && locationProp.environment === "wsl"
															? "system"
															: locationProp.environment,
												})
											}
										>
											<Icon name={location === "local" ? "computer" : "server"} className="h-3.5 w-3.5" />
											{location === "local"
												? t("settings.locationThisComputer")
												: t("settings.locationRemoteHost")}
										</button>
									))}
								</div>
							</div>
							<div className="gui-proj-axis">
								<span className="gui-proj-axis-label">{t("settings.instanceEnvironment")}</span>
								<div
									className="gui-conn-kinds"
									role="radiogroup"
									aria-label={t("settings.instanceEnvironment")}
								>
									{(["system", "container", "wsl"] as const).map(environment => {
										const reachable = !(locationProp.location === "remote" && environment === "wsl");
										return (
											<button
												key={environment}
												type="button"
												role="radio"
												aria-checked={locationProp.environment === environment}
												disabled={busy || !reachable}
												title={reachable ? undefined : t("settings.environmentRemoteUnsupported")}
												className="gui-conn-kind-btn"
												onClick={() => reachable && onLocationChange({ ...locationProp, environment })}
											>
												<Icon
													name={
														environment === "wsl"
															? "terminal-box"
															: environment === "container"
																? "stack"
																: "computer"
													}
													className="h-3.5 w-3.5"
												/>
												{environment === "system"
													? t("settings.environmentSystem")
													: environment === "container"
														? t("settings.environmentContainer")
														: t("settings.connectionKindWsl")}
											</button>
										);
									})}
								</div>
							</div>
							{locationProp.location === "remote" && (
								<>
									{hosts.length > 0 && (
										<div className="gui-proj-hosts" role="list">
											{hosts.map(host => (
												<button
													key={host.id}
													type="button"
													role="listitem"
													aria-pressed={locationProp.host === host.host}
													className="gui-proj-host"
													onClick={() => onLocationChange({ ...locationProp, host: host.host })}
												>
													{host.label}
												</button>
											))}
										</div>
									)}
									<input
										className="gui-input w-full font-mono"
										value={locationProp.host}
										placeholder={t("settings.connectionSshHostPlaceholder")}
										spellCheck={false}
										disabled={busy}
										aria-label={t("settings.connectionSshHost")}
										onChange={event => onLocationChange({ ...locationProp, host: event.target.value })}
									/>
								</>
							)}
						</div>
					</>
				)}

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
						onPick={() => {
							if (effectiveHost) {
								setRemotePick("source");
								return Promise.resolve(null);
							}
							return pickDirectory();
						}}
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

				{locationIncomplete && <p className="gui-project-dialog-hint">{t("settings.connectionHostRequired")}</p>}
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
			<RemotePathPicker
				open={remotePick !== null}
				rpc={rpc}
				hostLabel={effectiveHost ?? undefined}
				onClose={() => setRemotePick(null)}
				onPick={path => {
					if (remotePick === "primary") {
						setPrimary(path);
						setAdditional(current => current.filter(directory => !directoriesEqual(directory, path)));
						if (!nameTouched.current) setName(pathBaseName(path));
					} else {
						setAdditional(current => [...current, path]);
					}
				}}
			/>
		</DialogFrame>
	);
}
