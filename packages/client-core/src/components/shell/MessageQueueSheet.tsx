import { Pause as PauseIconData, Play as PlayIconData } from "lucide";
import { ArrowUp, Paperclip, Trash2, Undo2, X } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import type { SessionClient } from "../../lib/client";
import { haptic } from "../../lib/haptics";
import { normalizeQueueSnapshot, type QueueGroup, type QueueSnapshot } from "../../lib/message-queue";
import { useGuestSelector } from "../../lib/use-guest";
import type { MessageDisplayContext } from "../../messages/display-context";

export interface RestoredQueuedMessage {
	text: string;
	images?: { type: "image"; data: string; mimeType: string }[] | null;
	displayContext?: MessageDisplayContext;
}

export interface MessageQueueController {
	snapshot: QueueSnapshot | null;
	error: string | null;
	refresh(): Promise<void>;
	pop(group?: QueueGroup, id?: string): Promise<RestoredQueuedMessage | null>;
	clear(): Promise<void>;
	setPaused(paused: boolean): Promise<void>;
	send(group: QueueGroup, id: string): Promise<void>;
}

/** Shared daemon/collab queue state for the mobile and compact shell composer. */
export function useMessageQueue(client: SessionClient): MessageQueueController {
	const sessionId = useGuestSelector(client, state => state.focusedSessionId);
	const working = useGuestSelector(client, state => state.working);
	const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async (): Promise<void> => {
		if (!sessionId) {
			setSnapshot(null);
			return;
		}
		try {
			setSnapshot(normalizeQueueSnapshot(await client.rpc("session.queued", { sessionId })));
		} catch {
			// A transient reconnect keeps the last authoritative snapshot.
		}
	}, [client, sessionId]);

	useEffect(() => {
		setSnapshot(null);
		setError(null);
	}, [sessionId]);
	useEffect(() => {
		if (!sessionId) return;
		let disposed = false;
		const tick = (): void => {
			void client
				.rpc("session.queued", { sessionId })
				.then(value => {
					if (!disposed) setSnapshot(normalizeQueueSnapshot(value));
				})
				.catch(() => {});
		};
		tick();
		if (!working && !snapshot?.count) return;
		const timer = setInterval(tick, 3000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [client, sessionId, working, snapshot?.count]);

	const run = useCallback(
		async (method: string, params: Record<string, unknown>): Promise<void> => {
			if (!sessionId) return;
			try {
				setError(null);
				await client.rpc(method, { sessionId, ...params });
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[client, sessionId, refresh],
	);
	const pop = useCallback(
		async (group?: QueueGroup, id?: string): Promise<RestoredQueuedMessage | null> => {
			if (!sessionId) return null;
			try {
				setError(null);
				const restored = await client.rpc<RestoredQueuedMessage | null>("session.queuedPop", {
					sessionId,
					group,
					id,
				});
				await refresh();
				return restored;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				return null;
			}
		},
		[client, sessionId, refresh],
	);
	const clear = useCallback(() => run("session.queuedClear", {}), [run]);
	const setPaused = useCallback((paused: boolean) => run("session.queuedPause", { paused }), [run]);
	const send = useCallback((group: QueueGroup, id: string) => run("session.queuedSend", { group, id }), [run]);
	return { snapshot, error, refresh, pop, clear, setPaused, send };
}

export function MessageQueueSheet({
	open,
	readOnly,
	queue,
	onClose,
	onRestore,
}: {
	open: boolean;
	readOnly: boolean;
	queue: MessageQueueController;
	onClose(): void;
	onRestore(restored: RestoredQueuedMessage): void;
}): ReactNode {
	const [stage, setStage] = useState<"hidden" | "open" | "closing">(open ? "open" : "hidden");
	useEffect(() => {
		setStage(previous => (open ? "open" : previous === "open" ? "closing" : "hidden"));
		if (open) void queue.refresh();
	}, [open, queue.refresh]);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	useBackLayer(
		83,
		open,
		useCallback(() => {
			onClose();
			return true;
		}, [onClose]),
	);
	useEffect(() => {
		if (stage !== "closing") return;
		const timer = setTimeout(() => setStage("hidden"), 280);
		return () => clearTimeout(timer);
	}, [stage]);
	if (stage === "hidden") return null;
	const closing = stage === "closing";
	const snapshot = queue.snapshot;
	const renderGroup = (group: QueueGroup): ReactNode => {
		const items = snapshot?.[group] ?? [];
		if (items.length === 0) return null;
		return (
			<section className="sh-queue-group">
				<h3>{t(group === "steering" ? "general.steering" : "general.afterYield")}</h3>
				{items.map(item => (
					<div className="sh-queue-row" key={item.id}>
						<div className="sh-queue-copy">
							<span className="sh-queue-text">{item.text}</span>
							{item.imageCount > 0 && (
								<span className="sh-queue-attachments">
									<Paperclip size={12} /> {t("general.queuedAttachmentCount", { count: item.imageCount })}
								</span>
							)}
						</div>
						{!readOnly && (
							<div className="sh-queue-row-actions">
								<button
									type="button"
									title={t("general.takeBack")}
									aria-label={t("general.takeBack")}
									onClick={() => {
										void queue.pop(group, item.id).then(restored => {
											if (!restored) return;
											onRestore(restored);
											onClose();
											haptic(8);
										});
									}}
								>
									<Undo2 size={16} />
								</button>
								<button
									type="button"
									title={t("settings.delete")}
									aria-label={t("settings.delete")}
									onClick={() => void queue.pop(group, item.id)}
								>
									<Trash2 size={16} />
								</button>
								<button
									type="button"
									title={t("general.sendNow")}
									aria-label={t("general.sendNow")}
									onClick={() => void queue.send(group, item.id)}
								>
									<ArrowUp size={16} />
								</button>
							</div>
						)}
					</div>
				))}
			</section>
		);
	};
	return (
		<div className={`ss-backdrop${closing ? " ss-closing" : ""}`} role="presentation" onClick={onClose}>
			<div
				className={`ss-card sh-queue-card${closing ? " ss-closing" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={t("general.queuedMessages")}
				onClick={event => event.stopPropagation()}
				onAnimationEnd={() => {
					if (closing) setStage("hidden");
				}}
			>
				<div className="ss-grabber" aria-hidden />
				<div className="ss-card-head">
					<h2 className="ss-card-title">{t("general.queuedMessages")}</h2>
					<button type="button" className="ss-close" onClick={onClose} title={t("settings.close")}>
						<X size={16} />
					</button>
				</div>
				{snapshot?.paused && <p className="sh-queue-paused">{t("general.queuePausedHint")}</p>}
				{queue.error && (
					<p className="sh-queue-error" role="alert">
						{queue.error}
					</p>
				)}
				<div className="ss-list sh-queue-list">
					{renderGroup("steering")}
					{renderGroup("followUp")}
				</div>
				{!readOnly && (
					<div className="sh-queue-actions">
						<button
							type="button"
							disabled={!snapshot}
							onClick={() => {
								if (snapshot) void queue.setPaused(!snapshot.paused);
							}}
						>
							<MorphIcon
								icon={snapshot?.paused ? PlayIconData : PauseIconData}
								size={16}
								spring="snappy"
								reducedMotion="user"
							/>
							{t(snapshot?.paused ? "general.resumeQueue" : "general.pauseQueue")}
						</button>
						<button type="button" disabled={!snapshot?.count} onClick={() => void queue.clear()}>
							<Trash2 size={16} /> {t("general.clearQueue")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
