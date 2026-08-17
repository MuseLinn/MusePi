import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Live pending-message queue snapshot (session.queued wire shape). */
export interface QueueSnapshot {
	count: number;
	steering: string[];
	followUp: string[];
}

/** Pending-message queue (TUI /queue parity): editable list above the
 *  input — 取回 pops the newest queued message back into the editor,
 *  立即发出 pulls one out as an immediate steer. Rendered inside the
 *  composer's portaled queue menu. */
export function QueuePanel({
	queued,
	onSend,
	onPop,
	onClear,
}: {
	queued: QueueSnapshot;
	onSend(group: "steering" | "followUp", text: string, index: number): void;
	onPop(): void;
	onClear(): void;
}): ReactNode {
	return (
		<div className="gui-queue-panel" role="region" aria-label={t("queued messages")}>
			{/* Grouped like the TUI pending display: steering
			 * (immediate) vs after yield (next-turn). */}
			{queued.steering.length > 0 && (
				<>
					<div className="gui-queue-group">
						{t("Steering")} · {queued.steering.length}
					</div>
					{/* Steering messages are ALREADY the immediate queue — a
					 * send-now button would pull the message out only to
					 * re-inject it as a steer (count unchanged, UI flicker on
					 * the 3s poll reconcile). They can still be taken back. */}
					{queued.steering.map((msg, i) => (
						<div key={`s-${i}-${msg.slice(0, 12)}`} className="gui-queue-item">
							<span className="gui-queue-item-text" title={msg}>
								{msg}
							</span>
						</div>
					))}
				</>
			)}
			{queued.followUp.length > 0 && (
				<>
					<div className="gui-queue-group">
						{t("After yield")} · {queued.followUp.length}
					</div>
					{queued.followUp.map((msg, i) => (
						<div key={`f-${i}-${msg.slice(0, 12)}`} className="gui-queue-item">
							<span className="gui-queue-item-text" title={msg}>
								{msg}
							</span>
							<button
								type="button"
								className="gui-queue-send"
								title={t("send now")}
								aria-label={t("send now")}
								onClick={() => onSend("followUp", msg, i)}
							>
								<Icon name="arrow-up" className="h-3 w-3" />
							</button>
						</div>
					))}
				</>
			)}
			<div className="gui-queue-panel-actions">
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					onClick={() => void onPop()}
				>
					<Icon name="arrow-go-back" className="h-3 w-3" />
					<span>{t("take back newest")}</span>
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					onClick={() => void onClear()}
				>
					<Icon name="delete-bin" className="h-3 w-3" />
					<span>{t("clear queue")}</span>
				</button>
			</div>
		</div>
	);
}
