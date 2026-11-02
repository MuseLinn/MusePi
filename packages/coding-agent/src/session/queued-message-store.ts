import type { AgentMessage } from "@musepi/pi-agent-core";
import { isDisplayableQueuedMessage } from "./queued-messages";

interface MessageQueueStateEntry {
	type: string;
	customType?: unknown;
	data?: unknown;
}

export const MESSAGE_QUEUE_STATE_TYPE = "message_queue_state";

export interface QueuedMessageItem {
	id: string;
	text: string;
	imageCount: number;
}

export interface QueuedMessageSnapshot {
	paused: boolean;
	steering: QueuedMessageItem[];
	followUp: QueuedMessageItem[];
}

export interface PersistedQueuedMessage {
	id: string;
	message: AgentMessage;
}

export interface PersistedMessageQueueState {
	version: 1;
	paused: boolean;
	steering: PersistedQueuedMessage[];
	followUp: PersistedQueuedMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessages(value: unknown): PersistedQueuedMessage[] {
	if (!Array.isArray(value)) return [];
	const messages: PersistedQueuedMessage[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.message)) continue;
		if (typeof item.message.role !== "string") continue;
		messages.push({ id: item.id, message: item.message as unknown as AgentMessage });
	}
	return messages;
}

export function parseMessageQueueState(value: unknown): PersistedMessageQueueState | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.paused !== "boolean") return undefined;
	return {
		version: 1,
		paused: value.paused,
		steering: readMessages(value.steering),
		followUp: readMessages(value.followUp),
	};
}

/** Latest state on the active branch wins. Older branches stay untouched. */
export function readPersistedMessageQueue(
	entries: readonly MessageQueueStateEntry[],
): PersistedMessageQueueState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== MESSAGE_QUEUE_STATE_TYPE) continue;
		return parseMessageQueueState(entry.data);
	}
	return undefined;
}

/** Project the same displayable queue count used by a live AgentSession. */
export function readPersistedMessageQueueCount(entries: readonly MessageQueueStateEntry[]): number {
	const state = readPersistedMessageQueue(entries);
	if (!state) return 0;
	return [...state.steering, ...state.followUp].filter(item => isDisplayableQueuedMessage(item.message)).length;
}
