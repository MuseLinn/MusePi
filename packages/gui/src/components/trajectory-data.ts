/**
 * 会话轨迹数据构建(纯逻辑,无 DOM 依赖):从 MaterializedView entries
 * 构建事件时间线与统计。TrajectoryView 与单元测试共用。
 */
export interface TrajectoryEvent {
	id: string;
	kind: "assistant" | "tool" | "system" | "user";
	title: string;
	body?: string;
	result?: string;
	toolCallId?: string;
	turn: number;
	timestamp?: string;
}

export interface TrajectoryStats {
	durationSec: number;
	turns: number;
	calls: number;
	model?: string;
}

function truncate(text: string, max = 220): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringifyArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args);
		return s && s.length > 160 ? `${s.slice(0, 160)}…` : (s ?? "");
	} catch {
		return String(args ?? "");
	}
}

export function buildTrajectory(entries: readonly unknown[]): { events: TrajectoryEvent[]; stats: TrajectoryStats } {
	const events: TrajectoryEvent[] = [];
	let turn = 0;
	let toolCalls = 0;
	let assistantCount = 0;
	let firstTs: number | undefined;
	let lastTs: number | undefined;
	/** toolCallId → 最近的 TOOL 事件(结果回填)。 */
	const toolIndex = new Map<string, TrajectoryEvent>();

	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { type?: string; message?: Record<string, unknown>; timestamp?: string };
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		if (Number.isFinite(ts)) {
			if (firstTs === undefined) firstTs = ts;
			lastTs = ts;
		}
		const type = entry.type ?? "";
		const msg = entry.message as
			| {
					role?: string;
					content?: unknown;
					toolCallId?: string;
					name?: string;
					arguments?: unknown;
					result?: unknown;
			  }
			| undefined;

		if (type === "message" && msg?.role === "toolResult") {
			// ToolResultMessage:回填对应 TOOL 事件的结果预览。
			const target = toolIndex.get(msg.toolCallId ?? "");
			if (target) {
				const content = Array.isArray(msg.content)
					? (msg.content as Array<{ type?: string; text?: string }>)
							.filter(c => c?.type === "text")
							.map(c => c.text ?? "")
							.join(" ")
					: String(msg.content ?? "");
				target.result = truncate(content || String(msg.result ?? ""), 160);
			}
		} else if (type === "message" && msg) {
			if (msg.role === "user") {
				turn += 1;
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((c: { type?: string; text?: string }) => c?.type === "text")
							.map((c: { text?: string }) => c.text ?? "")
							.join(" ")
					: String(msg.content ?? "");
				if (text.trim())
					events.push({
						id: `user:${turn}:${ts}`,
						kind: "user",
						title: truncate(text.trim(), 80),
						turn,
						timestamp: entry.timestamp,
					});
				continue;
			}
			if (msg.role === "assistant") {
				assistantCount += 1;
				const parts = Array.isArray(msg.content) ? msg.content : [];
				let text = "";
				let thinking = "";
				for (const part of parts as Array<{
					type?: string;
					text?: string;
					thinking?: string;
					name?: string;
					id?: string;
					arguments?: unknown;
				}>) {
					if (part?.type === "text" && part.text) text += part.text;
					else if (part?.type === "thinking" && part.thinking) thinking += part.thinking;
					else if (part?.type === "toolCall" && part.name) {
						toolCalls += 1;
						const ev: TrajectoryEvent = {
							id: `tool:${turn}:${part.name}:${toolCalls}`,
							kind: "tool",
							title: part.name,
							body: stringifyArgs(part.arguments),
							turn,
							timestamp: entry.timestamp,
						};
						toolIndex.set(part.id ?? ev.id, ev);
						events.push(ev);
					}
				}
				const summary = text.trim() || (thinking.trim() ? `💭 ${truncate(thinking.trim(), 120)}` : "");
				if (summary) {
					events.push({
						id: `assistant:${turn}:${ts}`,
						kind: "assistant",
						title: truncate(summary, 120),
						body: truncate(summary),
						turn,
						timestamp: entry.timestamp,
					});
				}
			}
		} else if (type === "model_change" || type === "thinking_level_change") {
			// system 事件:title 用原始类型名,组件层映射 i18n(保持纯逻辑无 i18n 依赖)。
			events.push({ id: `${type}:${ts}`, kind: "system", title: type, turn, timestamp: entry.timestamp });
		}
	}

	return {
		events,
		stats: {
			durationSec:
				firstTs !== undefined && lastTs !== undefined ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0,
			turns: assistantCount,
			calls: toolCalls,
		},
	};
}
