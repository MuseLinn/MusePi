import { t } from "@musepi/guest-client";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

/**
 * Attach menu (kimi-code-web parity): ONE paperclip button replacing the
 * old insert (+) menu — image attachment, quick-insert tokens, and the
 * manual mode toggles (plan / goal) with their descriptions. Toggling a
 * mode keeps the menu open so the user can flip several at once; the
 * status chips above the composer reflect the live state.
 */
export function AttachMenu({
	onReady,
	goalMode,
	planMode,
	planDisabled = false,
	goalDisabled = false,
	onToggleGoal,
	onTogglePlan,
	onGuidedGoal,
	onPickImages,
	onPickFiles,
	onSketch,
	onInsert,
}: {
	goalMode: boolean;
	planMode: boolean;
	/** No active session (welcome state): plan/goal toggles are session
	 *  state, so they render disabled with an explanatory tooltip. */
	planDisabled?: boolean;
	goalDisabled?: boolean;
	onToggleGoal(): void;
	onTogglePlan(): void;
	/** TUI /guided-goal parity: the agent interviews the user in chat,
	 *  then creates the goal via its `goal` tool. */
	onGuidedGoal(): void;
	/** Opens the image file picker (attachment entry). */
	onPickImages(files: File[]): void;
	/** Opens the all-types file picker (general attachment entry). Optional:
	 *  the welcome composer has no workspace yet, so file attachments have
	 *  nowhere to land — the menu item is hidden until a session exists. */
	onPickFiles?(files: File[]): void;
	/** Opens the sketch board (Codex 绘画 parity). Works on the welcome
	 *  composer too — the PNG rides the normal image-attachment pipeline,
	 *  no workspace needed. */
	onSketch?(): void;
	/** Inserts a token (slash command / @mention / session ref) at the caret. */
	onInsert(token: string): void;
	/** Hands the host a way to open this menu — the composer frame's
	 *  trailing "+" chip routes here so there is exactly ONE attach surface
	 *  (the anchor and the pickers live in this component; a second picker
	 *  in the frame would drift from this one). */
	onReady?(open: () => void): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const anyFileRef = useRef<HTMLInputElement | null>(null);
	// Hand the opener up once (stable identity — `setOpen` never changes).
	// Effect, not render: emitting during render would be a side effect in
	// the render phase.
	useEffect(() => onReady?.(() => setOpen(true)), [onReady]);

	return (
		<div className="gui-model" ref={anchorRef}>
			<button
				type="button"
				className={`gui-composer-ico${open ? " gui-composer-ico--active" : ""}`}
				onClick={() => setOpen(v => !v)}
				title={t("attach")}
				aria-label={t("attach")}
				aria-expanded={open}
				aria-haspopup="menu"
			>
				<Icon name="add" className="h-3.5 w-3.5" />
			</button>
			{renderMenu(
				<div className="gui-attach-menu" role="menu" aria-label={t("attach")}>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							fileRef.current?.click();
						}}
					>
						<Icon name="file-image" className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate">{t("add images")}</span>
					</button>
					{onSketch && (
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								onSketch();
								setOpen(false);
							}}
						>
							<Icon name="palette" className="h-4 w-4" />
							<span className="min-w-0 flex-1 truncate">{t("sketch")}</span>
						</button>
					)}
					{onPickFiles && (
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								anyFileRef.current?.click();
							}}
						>
							<Icon name="file" className="h-4 w-4" />
							<span className="min-w-0 flex-1 truncate">{t("add attachments")}</span>
						</button>
					)}
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							onInsert("/");
							setOpen(false);
						}}
					>
						<Icon name="terminal" className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate">{t("insert command")}</span>
					</button>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							onInsert("@");
							setOpen(false);
						}}
					>
						<Icon name="chat-1" className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate">{t("mention file")}</span>
					</button>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							onInsert("#");
							setOpen(false);
						}}
					>
						<Icon name="chat-3" className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate">{t("insert session")}</span>
					</button>
					<div className="gui-creds-menu-sep" />
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						title={t("insert magic keyword hint")}
						onClick={() => {
							onInsert(" ultrathink ");
							setOpen(false);
						}}
					>
						<Icon name="brain-ai-3" className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate">{t("insert ultrathink")}</span>
					</button>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						title={t("insert magic keyword hint")}
						onClick={() => {
							onInsert(" workflowz ");
							setOpen(false);
						}}
					>
						<Icon name="git-branch" className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate">{t("insert workflowz")}</span>
					</button>
					<div className="gui-creds-menu-sep" />
					<button
						type="button"
						className={`gui-attach-opt${planMode ? " gui-attach-opt--on" : ""}${planDisabled ? " gui-attach-opt--disabled" : ""}`}
						role="menuitemcheckbox"
						aria-checked={planMode}
						disabled={planDisabled}
						title={planDisabled ? t("start a session to use plan mode") : undefined}
						onClick={onTogglePlan}
					>
						<Icon name="compass-3" className="h-4 w-4" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px] leading-tight text-[var(--color-text)]">
								{t("plan mode")}
							</span>
							<span className="block truncate text-[12px] leading-tight text-[var(--color-text-faint)]">
								{t("plan mode hint")}
							</span>
						</span>
						<span className={`gui-attach-switch${planMode ? " gui-attach-switch--on" : ""}`} aria-hidden>
							<span className="gui-attach-switch-knob" />
						</span>
					</button>
					<button
						type="button"
						className={`gui-attach-opt${goalMode ? " gui-attach-opt--on" : ""}${goalDisabled ? " gui-attach-opt--disabled" : ""}`}
						role="menuitemcheckbox"
						aria-checked={goalMode}
						disabled={goalDisabled}
						title={goalDisabled ? t("start a session to use goal mode") : undefined}
						onClick={onToggleGoal}
					>
						<Icon name="target" className="h-4 w-4" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px] leading-tight text-[var(--color-text)]">
								{t("goal mode")}
							</span>
							<span className="block truncate text-[12px] leading-tight text-[var(--color-text-faint)]">
								{t("goal mode hint")}
							</span>
						</span>
						<span className={`gui-attach-switch${goalMode ? " gui-attach-switch--on" : ""}`} aria-hidden>
							<span className="gui-attach-switch-knob" />
						</span>
					</button>
					<button
						type="button"
						className={`gui-attach-opt${goalDisabled ? " gui-attach-opt--disabled" : ""}`}
						role="menuitem"
						disabled={goalDisabled}
						title={goalDisabled ? t("start a session to use goal mode") : undefined}
						onClick={() => {
							onGuidedGoal();
							setOpen(false);
						}}
					>
						<Icon name="chat-1" className="h-4 w-4" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px] leading-tight text-[var(--color-text)]">
								{t("guided goal mode")}
							</span>
							<span className="block truncate text-[12px] leading-tight text-[var(--color-text-faint)]">
								{t("guided goal mode hint")}
							</span>
						</span>
					</button>
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={e => {
							const files = e.target.files ? [...e.target.files] : [];
							if (files.length > 0) onPickImages(files);
							e.target.value = "";
						}}
					/>
					{/* General attachment entry (openchamber parity): NO accept
					 *  restriction — any file the OS picker allows becomes a chip;
					 *  the send path routes it through fs.write into the workspace. */}
					<input
						ref={anyFileRef}
						type="file"
						multiple
						hidden
						onChange={e => {
							const files = e.target.files ? [...e.target.files] : [];
							if (files.length > 0) onPickFiles?.(files);
							e.target.value = "";
						}}
					/>
				</div>,
			)}
		</div>
	);
}
