import { type TranslationKey, t } from "@musepi/guest-client";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { Icon } from "../../vendor/oc-icons";

/**
 * Approval-mode button (openchamber input permission-picker parity): a
 * permanent pill in the composer footer showing the live
 * `tools.approvalMode` and letting the user flip it without a trip to
 * Settings. The daemon's tool wrapper re-reads the setting on every tool
 * call (extensions/wrapper.ts), so a change here takes effect on the next
 * call — no per-session state involved.
 *
 * Reads `settings.get`, writes `settings.set` (optimistic; a failed write
 * snaps back to the daemon's value on the next mount — good enough for a
 * three-way global switch whose failure path surfaces in Settings).
 */

/** `tools.approvalMode` (settings-schema enum). */
type ApprovalMode = "always-ask" | "write" | "yolo";

const MODES: readonly {
	value: ApprovalMode;
	short: TranslationKey;
	label: TranslationKey;
	hint: TranslationKey;
}[] = [
	{
		value: "always-ask",
		short: "approval short always ask",
		label: "approval mode always ask",
		hint: "approval mode always ask hint",
	},
	{
		value: "write",
		short: "approval short write",
		label: "approval mode write",
		hint: "approval mode write hint",
	},
	{
		value: "yolo",
		short: "approval short yolo",
		label: "approval mode yolo",
		hint: "approval mode yolo hint",
	},
];

function isApprovalMode(v: unknown): v is ApprovalMode {
	return v === "always-ask" || v === "write" || v === "yolo";
}

export function ApprovalModeButton({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [mode, setMode] = useState<ApprovalMode>("yolo");
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);

	// Load the live value once per daemon connection; unknown/missing stays
	// on the schema default (yolo) — same fallback the daemon applies.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, unknown>>("settings.get", { keys: ["tools.approvalMode"] })
			.then(res => {
				const v = res?.["tools.approvalMode"];
				if (alive && isApprovalMode(v)) setMode(v);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const pick = useCallback(
		(next: ApprovalMode): void => {
			setOpen(false);
			if (next === mode) return;
			const prev = mode;
			setMode(next); // optimistic — the write is a single enum flip
			void rpc?.request("settings.set", { key: "tools.approvalMode", value: next }).catch(() => {
				// Roll back on failure so the pill never lies about a mode the
				// daemon refused to persist.
				setMode(prev);
			});
		},
		[rpc, mode],
	);

	const current = MODES.find(m => m.value === mode) ?? MODES[2]!;
	return (
		<div ref={anchorRef} className="gui-approval">
			<button
				type="button"
				className={`gui-mode-toggle-arm gui-approval-btn${mode === "write" ? " gui-mode-toggle-arm--armed" : ""}${
					mode === "yolo" ? " gui-approval-btn--yolo" : ""
				}${open ? " gui-approval-btn--open" : ""}`}
				title={t("approval mode")}
				aria-label={t("approval mode")}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="shield" className="h-3 w-3" />
				{t(current.short)}
			</button>
			{renderMenu(
				<div className="gui-attach-menu gui-approval-menu" role="menu" aria-label={t("approval mode")}>
					<div className="gui-approval-menu-head">{t("approval mode")}</div>
					{MODES.map(m => (
						<button
							key={m.value}
							type="button"
							className={`gui-attach-opt${mode === m.value ? " gui-attach-opt--on" : ""}`}
							role="menuitemradio"
							aria-checked={mode === m.value}
							onClick={() => pick(m.value)}
						>
							<Icon name={mode === m.value ? "check" : "shield"} className="h-4 w-4" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] leading-tight text-[var(--color-text)]">
									{t(m.label)}
								</span>
								<span className="block truncate text-[12px] leading-tight text-[var(--color-text-faint)]">
									{t(m.hint)}
								</span>
							</span>
						</button>
					))}
				</div>,
			)}
		</div>
	);
}
