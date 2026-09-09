import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../i18n/index.js";
import { SendChip } from "./send";

/** Todo widget — local checklist (kimi 待办打卡 pattern). */
interface TodoItem {
	id: number;
	text: string;
	done: boolean;
}

export function TodoCard({
	data,
	update,
	sendPrompt,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
	sendPrompt?(text: string): void;
}): ReactNode {
	const items = (Array.isArray(data.items) ? data.items : []) as TodoItem[];
	const [draft, setDraft] = useState("");

	const setItems = (next: TodoItem[]): void => update({ items: next });

	return (
		<div className="gui-widget-todo">
			<div className="gui-widget-todo-list">
				{items.length === 0 && <div className="gui-widget-todo-empty">{t("widget todo empty")}</div>}
				{items.map(item => (
					<div key={item.id} className="gui-widget-todo-item">
						<button
							type="button"
							className={`gui-widget-todo-check${item.done ? " gui-widget-todo-check--done" : ""}`}
							aria-label={t("widget todo toggle")}
							onClick={() => setItems(items.map(i => (i.id === item.id ? { ...i, done: !i.done } : i)))}
						>
							{item.done ? "✓" : ""}
						</button>
						<span className={`gui-widget-todo-text${item.done ? " gui-widget-todo-text--done" : ""}`}>
							{item.text}
						</span>
						<button
							type="button"
							className="gui-widget-todo-del"
							aria-label={t("widget todo remove")}
							onClick={() => setItems(items.filter(i => i.id !== item.id))}
						>
							×
						</button>
					</div>
				))}
			</div>
			<div className="gui-widget-todo-add">
				<input
					className="gui-widget-todo-input"
					value={draft}
					placeholder={t("widget todo add")}
					onChange={e => setDraft(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && draft.trim()) {
							setItems([...items, { id: Date.now(), text: draft.trim(), done: false }]);
							setDraft("");
						}
					}}
				/>
				<button
					type="button"
					className="gui-widget-todo-btn"
					disabled={!draft.trim()}
					onClick={() => {
						setItems([...items, { id: Date.now(), text: draft.trim(), done: false }]);
						setDraft("");
					}}
				>
					+
				</button>
			</div>

			<SendChip
				text={`${t("widget todo done")} ${items.filter(i => i.done).length}/${items.length}`}
				onSend={sendPrompt}
			/>
		</div>
	);
}
