import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { QueuedMessageItem, QueueGroup, QueueSnapshot } from "@musepi/client-core/src/lib/message-queue";
import { Pause as PauseIconData, Play as PlayIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Pending-message queue with durable ids, pause control and in-group reordering. */
export function QueuePanel({
	queued,
	onSend,
	onPop,
	onEdit,
	onDelete,
	onClear,
	onReorder,
	onTogglePause,
}: {
	queued: QueueSnapshot;
	onSend(group: QueueGroup, id: string): void;
	onPop(group?: QueueGroup, id?: string): void;
	onEdit(group: QueueGroup, id: string): void;
	onDelete(group: QueueGroup, id: string): void;
	onClear(): void;
	onReorder(group: QueueGroup, fromId: string, toId: string): void;
	onTogglePause(): void;
}): ReactNode {
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
	const handleDragEnd =
		(group: QueueGroup) =>
		(event: DragEndEvent): void => {
			const over = event.over;
			if (!over || event.active.id === over.id) return;
			onReorder(group, String(event.active.id), String(over.id));
		};
	const renderGroup = (group: QueueGroup, items: readonly QueuedMessageItem[]): ReactNode => {
		if (items.length === 0) return null;
		return (
			<>
				<div className="gui-queue-group">
					{t(group === "steering" ? "general.steering" : "general.afterYield")} · {items.length}
				</div>
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd(group)}>
					<SortableContext items={items.map(item => item.id)} strategy={verticalListSortingStrategy}>
						{items.map(item => (
							<SortableQueueItem
								key={item.id}
								item={item}
								onPop={() => onPop(group, item.id)}
								onEdit={() => onEdit(group, item.id)}
								onDelete={() => onDelete(group, item.id)}
								onSend={() => onSend(group, item.id)}
							/>
						))}
					</SortableContext>
				</DndContext>
			</>
		);
	};
	return (
		<div className="gui-queue-panel" role="region" aria-label={t("general.queuedMessages")}>
			{renderGroup("steering", queued.steering)}
			{renderGroup("followUp", queued.followUp)}
			<div className="gui-queue-panel-actions">
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={onTogglePause}>
					<MorphIcon
						icon={queued.paused ? PlayIconData : PauseIconData}
						size={12}
						spring="snappy"
						reducedMotion="user"
						className="h-3 w-3"
					/>
					<span>{t(queued.paused ? "general.resumeQueue" : "general.pauseQueue")}</span>
				</button>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={() => void onPop()}>
					<Icon name="arrow-go-back" className="h-3 w-3" />
					<span>{t("general.takeBackNewest")}</span>
				</button>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={() => void onClear()}>
					<Icon name="delete-bin" className="h-3 w-3" />
					<span>{t("general.clearQueue")}</span>
				</button>
			</div>
		</div>
	);
}

function SortableQueueItem({
	item,
	onPop,
	onEdit,
	onDelete,
	onSend,
}: {
	item: QueuedMessageItem;
	onPop(): void;
	onEdit(): void;
	onDelete(): void;
	onSend(): void;
}): ReactNode {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id: item.id,
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
				title={t("general.dragReorderQueuedMessage")}
				aria-label={t("general.dragReorderQueuedMessage")}
				{...attributes}
				{...listeners}
			>
				<Icon name="draggable" className="h-3 w-3" />
			</button>
			<span className="gui-queue-item-text" title={item.text}>
				{item.text}
			</span>
			{item.imageCount > 0 && (
				<span
					className="gui-queue-item-attachments"
					title={t("general.queuedAttachmentCount", { count: item.imageCount })}
				>
					<Icon name="attachment-2" className="h-3 w-3" />
					{item.imageCount}
				</span>
			)}
			<button
				type="button"
				className="gui-queue-send"
				title={t("general.takeBack")}
				aria-label={t("general.takeBack")}
				onClick={onPop}
			>
				<Icon name="arrow-go-back" className="h-3 w-3" />
			</button>
			<button
				type="button"
				className="gui-queue-send"
				title={t("settings.edit")}
				aria-label={t("settings.edit")}
				onClick={onEdit}
			>
				<Icon name="edit-2" className="h-3 w-3" />
			</button>
			<button
				type="button"
				className="gui-queue-send"
				title={t("settings.delete")}
				aria-label={t("settings.delete")}
				onClick={onDelete}
			>
				<Icon name="delete-bin" className="h-3 w-3" />
			</button>
			<button
				type="button"
				className="gui-queue-send"
				title={t("general.sendNow")}
				aria-label={t("general.sendNow")}
				onClick={onSend}
			>
				<Icon name="arrow-up" className="h-3 w-3" />
			</button>
		</div>
	);
}
