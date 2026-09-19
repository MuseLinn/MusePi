import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Live pending-message queue snapshot (session.queued wire shape). */
export interface QueueSnapshot {
	count: number;
	steering: string[];
	followUp: string[];
}

type Group = "steering" | "followUp";

/** Pending-message queue (TUI /queue parity): editable list above the
 *  input — 取回 pops the newest queued message back into the editor,
 *  立即发出 pulls one out as an immediate steer. Rows drag to reorder
 *  within their own group (openchamber QueuedMessageChips parity, @dnd-kit).
 *  Rendered inside the composer's portaled queue menu. */
export function QueuePanel({
	queued,
	onSend,
	onPop,
	onEdit,
	onDelete,
	onClear,
	onReorder,
}: {
	queued: QueueSnapshot;
	onSend(group: Group, text: string, index: number): void;
	onPop(group?: Group, text?: string): void;
	/** Per-row ✎: same daemon path as 取回 (pop into the editor) — the user
	 *  lands in the textarea able to amend before re-sending. */
	onEdit(group: Group, text: string): void;
	/** Per-row 🗑: drop just this message (pop + discard, never re-queued). */
	onDelete(group: Group, text: string): void;
	onClear(): void;
	onReorder(group: Group, from: string, to: string): void;
}): ReactNode {
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
	const handleDragEnd =
		(group: Group) =>
		(e: DragEndEvent): void => {
			const from = idToText(String(e.active.id));
			const over = e.over;
			if (!over || from === undefined) return;
			const to = idToText(String(over.id));
			if (to === undefined || from === to) return;
			onReorder(group, from, to);
		};
	return (
		<div className="gui-queue-panel" role="region" aria-label={t("queued messages")}>
			{queued.steering.length > 0 && (
				<>
					<div className="gui-queue-group">
						{t("Steering")} · {queued.steering.length}
					</div>
					{/* Steering (引导) messages are the immediate queue: they are
					 * delivered in order while the agent runs. "Send now" still
					 * has meaning here — it pulls THAT message out of the queue
					 * (agent.sendQueuedMessage removes it) and delivers it as a
					 * steer immediately, skipping whatever is queued ahead of
					 * it. Mirrors the After-yield item actions below. */}
					<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("steering")}>
						<SortableContext
							items={queued.steering.map(msg => textToId("steering", msg))}
							strategy={verticalListSortingStrategy}
						>
							{queued.steering.map((msg, i) => (
								<SortableQueueItem
									key={`s-${i}-${msg.slice(0, 12)}`}
									id={textToId("steering", msg)}
									msg={msg}
									onPop={() => onPop("steering", msg)}
									onEdit={() => onEdit("steering", msg)}
									onDelete={() => onDelete("steering", msg)}
									onSend={() => onSend("steering", msg, i)}
								/>
							))}
						</SortableContext>
					</DndContext>
				</>
			)}
			{queued.followUp.length > 0 && (
				<>
					<div className="gui-queue-group">
						{t("After yield")} · {queued.followUp.length}
					</div>
					<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("followUp")}>
						<SortableContext
							items={queued.followUp.map(msg => textToId("followUp", msg))}
							strategy={verticalListSortingStrategy}
						>
							{queued.followUp.map((msg, i) => (
								<SortableQueueItem
									key={`f-${i}-${msg.slice(0, 12)}`}
									id={textToId("followUp", msg)}
									msg={msg}
									onPop={() => onPop("followUp", msg)}
									onEdit={() => onEdit("followUp", msg)}
									onDelete={() => onDelete("followUp", msg)}
									onSend={() => onSend("followUp", msg, i)}
								/>
							))}
						</SortableContext>
					</DndContext>
				</>
			)}
			<div className="gui-queue-panel-actions">
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={() => void onPop()}>
					<Icon name="arrow-go-back" className="h-3 w-3" />
					<span>{t("take back newest")}</span>
				</button>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={() => void onClear()}>
					<Icon name="delete-bin" className="h-3 w-3" />
					<span>{t("clear queue")}</span>
				</button>
			</div>
		</div>
	);
}

/** Stable sortable id encodes group + text (the daemon text-matches the same
 *  way — first match wins, so duplicate texts collide identically on both
 *  sides). */
const textToId = (group: Group, text: string): string => `${group === "steering" ? "s" : "f"}:${text}`;
const idToText = (id: string): string | undefined => {
	const sep = id.indexOf(":");
	return sep === -1 ? undefined : id.slice(sep + 1);
};

function SortableQueueItem({
	id,
	msg,
	onPop,
	onEdit,
	onDelete,
	onSend,
}: {
	id: string;
	msg: string;
	onPop(): void;
	onEdit(): void;
	onDelete(): void;
	onSend(): void;
}): ReactNode {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});
	return (
		<div
			ref={setNodeRef}
			className={`gui-queue-item${isDragging ? " gui-queue-item--dragging" : ""}`}
			style={transform ? { transform: CSS.Transform.toString(transform), transition } : undefined}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				className="gui-queue-grip"
				title={t("drag to reorder queued message")}
				aria-label={t("drag to reorder queued message")}
				{...attributes}
				{...listeners}
			>
				<Icon name="draggable" className="h-3 w-3" />
			</button>
			<span className="gui-queue-item-text" title={msg}>
				{msg}
			</span>
			<button
				type="button"
				className="gui-queue-send"
				title={t("take back")}
				aria-label={t("take back")}
				onClick={onPop}
			>
				<Icon name="arrow-go-back" className="h-3 w-3" />
			</button>
			<button type="button" className="gui-queue-send" title={t("edit")} aria-label={t("edit")} onClick={onEdit}>
				<Icon name="edit-2" className="h-3 w-3" />
			</button>
			<button
				type="button"
				className="gui-queue-send"
				title={t("delete")}
				aria-label={t("delete")}
				onClick={onDelete}
			>
				<Icon name="delete-bin" className="h-3 w-3" />
			</button>
			<button
				type="button"
				className="gui-queue-send"
				title={t("send now")}
				aria-label={t("send now")}
				onClick={onSend}
			>
				<Icon name="arrow-up" className="h-3 w-3" />
			</button>
		</div>
	);
}
