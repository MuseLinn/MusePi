import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Swarm status chip (kimiwork parity): while a `task` tool is running, a
 * temporary chip sits above the input; clicking opens the frosted floating
 * member grid (avatars + progress) — the portaled menu is passed in. */
export function SwarmChip({
	open,
	onToggle,
	anchorRef,
	menu,
}: {
	open: boolean;
	onToggle(): void;
	anchorRef(el: HTMLElement | null): void;
	menu: ReactNode;
}): ReactNode {
	return (
		<>
			<button
				type="button"
				ref={anchorRef}
				className={`gui-swarm-chip${open ? " gui-swarm-chip--open" : ""}`}
				title={t("swarm members")}
				aria-expanded={open}
				onClick={onToggle}
			>
				<span className="gui-swarm-chip-dot" aria-hidden="true" />
				<span className="gui-swarm-chip-label">{t("swarm members")}</span>
			</button>
			{menu}
		</>
	);
}

/** Todo progress chip (TUI /todo parity): compact fill bar + counts. */
export function TodoChip({
	open,
	onToggle,
	anchorRef,
	done,
	total,
	title,
}: {
	open: boolean;
	onToggle(): void;
	anchorRef(el: HTMLElement | null): void;
	done: number;
	total: number;
	title: string;
}): ReactNode {
	return (
		<button
			type="button"
			ref={anchorRef}
			className={`gui-todo-chip${open ? " gui-todo-chip--open" : ""}`}
			title={title}
			aria-expanded={open}
			onClick={onToggle}
		>
			<div className="gui-todo-bar">
				<div className="gui-todo-fill" style={{ width: `${(done / total) * 100}%` }} />
			</div>
			<span className="gui-todo-label">
				{done}/{total}
			</span>
		</button>
	);
}

/** Pending-queue toggle chip (TUI /queue parity) — opens the queue panel. */
export function QueueToggleChip({
	open,
	onToggle,
	anchorRef,
	count,
}: {
	open: boolean;
	onToggle(): void;
	anchorRef(el: HTMLElement | null): void;
	count: number;
}): ReactNode {
	return (
		<button
			type="button"
			ref={anchorRef}
			className={`gui-queue-chip${open ? " gui-queue-chip--open" : ""}`}
			aria-expanded={open}
			onClick={onToggle}
		>
			<Icon name="list-unordered" className="h-3 w-3" />
			<span>{t("queued {count}", { count: String(count) })}</span>
		</button>
	);
}
