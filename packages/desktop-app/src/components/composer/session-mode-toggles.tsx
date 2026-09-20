/**
 * Session mode toggles (TUI /fast /computer /vision /prewalk parity): a
 * compact popover in the composer action row. Data comes from the 10s
 * session.modes poll (useModeToggles); each control mutates through the
 * daemon RPC and merges the response back immediately. RPC failures keep
 * the last known state (fail silent).
 */
import { Segmented, type SegmentedOption } from "@musepi/guest-client";
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import type { RpcClient } from "../../lib/rpc";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { Icon } from "../../vendor/oc-icons";
import { useModeToggles } from "./use-mode-toggles";

export function SessionModeToggles({ rpc, sessionId }: { rpc: RpcClient; sessionId: string }): ReactNode {
	const { state, toggleFast, toggleComputer, setVision, armPrewalk } = useModeToggles(rpc, sessionId);
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const fastOn = state.fastModeEnabled;
	const fastInactive = fastOn && !state.fastModeActive;
	const computerOn = state.computerEnabled;
	const visionMode = state.vision.mode;
	const prewalkArmed = state.prewalk.enabled;
	// Built in render (not module scope) so a locale switch re-labels them.
	const visionSegments: SegmentedOption<typeof visionMode>[] = [
		{ value: "auto", label: t("vision auto") },
		{ value: "on", label: t("vision on") },
		{ value: "off", label: t("vision off") },
	];
	return (
		<div ref={anchorRef} className="gui-mode-toggles">
			<button
				type="button"
				className={`gui-composer-ico${open ? " gui-composer-ico--active" : ""}`}
				title={t("mode toggles")}
				aria-label={t("mode toggles")}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="equalizer-2" className="h-3.5 w-3.5" />
			</button>
			{renderMenu(
				<div className="gui-mode-toggle-popover" role="dialog" aria-label={t("mode toggles")}>
					{/* Fast priority tier switch: the switch mirrors the enabled
					 * intent; when enabled but the active model does not realize
					 * it (fastModeActive false) show a muted note. */}
					<div className="gui-mode-toggle-row">
						<span className="gui-mode-toggle-label">
							<Icon name="pulse" className="h-3 w-3" />
							{t("fast mode")}
						</span>
						<button
							type="button"
							role="switch"
							aria-checked={fastOn}
							aria-label={t("fast mode")}
							className={`gui-toggle gui-toggle--sm${fastOn ? " gui-toggle--on" : ""}`}
							onClick={toggleFast}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					{fastInactive ? <div className="gui-mode-toggle-note">{t("fast mode unavailable")}</div> : null}
					{/* Computer tool switch. */}
					<div className="gui-mode-toggle-row">
						<span className="gui-mode-toggle-label">
							<Icon name="computer" className="h-3 w-3" />
							{t("computer tool")}
						</span>
						<button
							type="button"
							role="switch"
							aria-checked={computerOn}
							aria-label={t("computer tool")}
							className={`gui-toggle gui-toggle--sm${computerOn ? " gui-toggle--on" : ""}`}
							onClick={toggleComputer}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					{/* Vision delegation mode: segmented auto/on/off. */}
					<div className="gui-mode-toggle-row">
						<span className="gui-mode-toggle-label">
							<Icon name="eye" className="h-3 w-3" />
							{t("vision mode")}
						</span>
						<Segmented
							className="gui-seg--compact"
							ariaLabel={t("vision mode")}
							value={visionMode}
							options={visionSegments}
							onChange={setVision}
						/>
					</div>
					{/* Prewalk: one-shot arm with @smol; shows armed state. */}
					<div className="gui-mode-toggle-row">
						<span className="gui-mode-toggle-label">
							<Icon name="brain-ai-3" className="h-3 w-3" />
							{t("prewalk")}
						</span>
						<button
							type="button"
							className={`gui-mode-toggle-arm${prewalkArmed ? " gui-mode-toggle-arm--armed" : ""}`}
							onClick={armPrewalk}
							aria-pressed={prewalkArmed}
						>
							{prewalkArmed ? <Icon name="check" className="h-3 w-3" /> : null}
							{t(prewalkArmed ? "prewalk armed" : "prewalk")}
						</button>
					</div>
				</div>,
			)}
		</div>
	);
}
