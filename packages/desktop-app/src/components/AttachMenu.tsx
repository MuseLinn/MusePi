import { t, tLoose } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { bindingLabel } from "../lib/shortcut-registry";
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
	onCaptureScreen,
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
	/** kimicode 截屏 parity: captures the primary display and opens the
	 *  annotate board on the shot (⇧⌘S also routes here — rebinding lives in
	 *  the shortcut registry, the chip shows the live binding). */
	onCaptureScreen?(): void;
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
						<Icon name="file-image" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("add images")}</span>
							<span className="gui-attach-opt-hint">{tLoose("add images desc")}</span>
						</span>
					</button>
					{/* kimicode "+" menu parity: icon + label + one-line desc per
					 *  row; the 截屏 row carries the LIVE binding from the
					 *  shortcut registry (rebinding in 设置 → 快捷键 shows up
					 *  here immediately). */}
					{onCaptureScreen && (
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								onCaptureScreen();
								setOpen(false);
							}}
						>
							<Icon name="camera" className="h-4 w-4 gui-attach-opt-ico" />
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{tLoose("attach capture screen")}</span>
								<span className="gui-attach-opt-hint">{tLoose("attach capture screen desc")}</span>
							</span>
							<kbd className="gui-attach-keys">{bindingLabel("capture-screen")}</kbd>
						</button>
					)}
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
							<Icon name="palette" className="h-4 w-4 gui-attach-opt-ico" />
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{t("sketch")}</span>
								<span className="gui-attach-opt-hint">{tLoose("sketch desc")}</span>
							</span>
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
							<Icon name="file" className="h-4 w-4 gui-attach-opt-ico" />
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{t("add attachments")}</span>
								<span className="gui-attach-opt-hint">{tLoose("add attachments desc")}</span>
							</span>
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
						<Icon name="terminal" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert command")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert command desc")}</span>
						</span>
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
						<Icon name="chat-1" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("mention file")}</span>
							<span className="gui-attach-opt-hint">{tLoose("mention file desc")}</span>
						</span>
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
						<Icon name="chat-3" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert session")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert session desc")}</span>
						</span>
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
						<Icon name="brain-ai-3" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert ultrathink")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert ultrathink desc")}</span>
						</span>
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
						<Icon name="git-branch" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert workflowz")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert workflowz desc")}</span>
						</span>
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
						<Icon name="compass-3" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("plan mode")}</span>
							<span className="gui-attach-opt-hint">{t("plan mode hint")}</span>
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
						<Icon name="target" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("goal mode")}</span>
							<span className="gui-attach-opt-hint">{t("goal mode hint")}</span>
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
							<span className="gui-attach-opt-title">{t("guided goal mode")}</span>
							<span className="gui-attach-opt-hint">{t("guided goal mode hint")}</span>
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
