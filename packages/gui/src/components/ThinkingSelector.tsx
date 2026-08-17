import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { tapFeedback } from "../lib/haptic";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";
import { THINKING_LEVELS, thinkingLabel } from "./thinking-selector-shared";

/** Thinking effort ladder + auto (per-model default, TUI /settings
 * defaultThinkingLevel parity). */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number] | "auto";

const LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Thinking-effort selector (openchamber/opencode model-row parity): a
 * capsule button showing the current level with a dropdown of the six
 * efforts plus off. Controlled — the parent owns persistence (daemon
 * session.setThinkingLevel). The menu is portaled into body like the model
 * selector so no ancestor clips it.
 *
 * When `efforts` is provided (the current model's exact ladder from
 * getSupportedEfforts, TUI /model parity) the menu renders off/auto plus
 * exactly those rungs; without it the full fixed ladder shows.
 */
export function ThinkingSelector({
	value,
	onChange,
	ceiling,
	efforts,
}: {
	value: string | null | undefined;
	onChange(level: ThinkingLevel | null): void;
	/** Per-model effort cap — rungs above it are disabled (TUI parity). */
	ceiling?: string | null;
	/** Exact effort ladder of the current model; undefined = full ladder. */
	efforts?: readonly string[] | null;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);

	useEffect(() => {
		const onDoc = (e: MouseEvent): void => {
			const path = e.composedPath();
			if (
				path.some(
					el =>
						el instanceof HTMLElement &&
						(el.classList?.contains("gui-model-btn") || el.classList?.contains("gui-menu-popup")),
				)
			) {
				return;
			}
			setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, []);

	return (
		<div className="gui-model" ref={anchorRef}>
			<button
				type="button"
				className="gui-model-btn"
				onClick={() => setOpen(v => !v)}
				title={t("thinking level")}
				aria-label={t("thinking level")}
			>
				<Icon name="brain" className="h-3.5 w-3.5" />
				<span className="max-w-[120px] truncate">{thinkingLabel(value)}</span>
				<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
			</button>
			{renderMenu(
				<div className="gui-model-menu">
					<button
						type="button"
						className={`gui-model-opt${value == null ? " gui-model-opt--active" : ""}`}
						onClick={() => {
							tapFeedback(1);
							onChange(null);
							setOpen(false);
						}}
					>
						<span className="min-w-0 flex-1 truncate">{t("thinking off")}</span>
						{value == null && <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />}
					</button>
					<button
						type="button"
						className={`gui-model-opt${value === "auto" ? " gui-model-opt--active" : ""}`}
						onClick={() => {
							tapFeedback(1);
							onChange("auto");
							setOpen(false);
						}}
					>
						<span className="min-w-0 flex-1 truncate">{t("thinking auto")}</span>
						{value === "auto" && <Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />}
					</button>
					{efforts !== undefined && efforts !== null
						? efforts.map(level => {
								const capped =
									ceiling !== null &&
									ceiling !== undefined &&
									LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(ceiling);
								return (
									<button
										key={level}
										type="button"
										disabled={capped}
										className={`gui-model-opt${value === level ? " gui-model-opt--active" : ""}${capped ? " gui-model-opt--capped" : ""}`}
										title={capped ? t("thinking capped by model") : undefined}
										onClick={() => {
											if (capped) return;
											tapFeedback(1);
											onChange(level as ThinkingLevel);
											setOpen(false);
										}}
									>
										<span className="min-w-0 flex-1 truncate">{thinkingLabel(level)}</span>
										{capped && <span className="gui-provider-chip">{t("model cap")}</span>}
										{value === level && !capped && (
											<Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />
										)}
									</button>
								);
							})
						: THINKING_LEVELS.map(level => {
								const capped =
									ceiling !== null &&
									ceiling !== undefined &&
									LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(ceiling);
								return (
									<button
										key={level}
										type="button"
										disabled={capped}
										className={`gui-model-opt${value === level ? " gui-model-opt--active" : ""}${capped ? " gui-model-opt--capped" : ""}`}
										title={capped ? t("thinking capped by model") : undefined}
										onClick={() => {
											if (capped) return;
											tapFeedback(1);
											onChange(level);
											setOpen(false);
										}}
									>
										<span className="min-w-0 flex-1 truncate">{thinkingLabel(level)}</span>
										{capped && <span className="gui-provider-chip">{t("model cap")}</span>}
										{value === level && !capped && (
											<Icon name="check" className="h-3.5 w-3.5 flex-shrink-0" />
										)}
									</button>
								);
							})}
				</div>,
			)}
		</div>
	);
}
