import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
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
	goalMode,
	planMode,
	planDisabled = false,
	goalDisabled = false,
	onToggleGoal,
	onTogglePlan,
	onPickImages,
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
	/** Opens the image file picker (attachment entry). */
	onPickImages(files: File[]): void;
	/** Inserts a token (slash command / @mention / session ref) at the caret. */
	onInsert(token: string): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const fileRef = useRef<HTMLInputElement | null>(null);

	return (
		<>
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
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								onInsert(" /");
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
								onInsert(" @");
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
								onInsert(" #");
								setOpen(false);
							}}
						>
							<Icon name="chat-3" className="h-4 w-4" />
							<span className="min-w-0 flex-1 truncate">{t("insert session")}</span>
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
					</div>,
				)}
			</div>
		</>
	);
}
