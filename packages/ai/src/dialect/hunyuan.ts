/**
 * Hunyuan（腾讯混元系，含 CodeBuddy 的 Hy3 / Hunyuan 路由）的内联工具方言。
 *
 * ## 真实泄漏形态（实测会话原文，非推测）
 *
 * ```text
 * <tool_calls:6124c78e>
 * <tool_call:6124c78e>read
 *  OPTIONS={"path":"skill://widget-design"}
 * ```
 *
 * - 外层 `<tool_calls:ID>`（复数）包一批调用，ID 是 8 位十六进制；
 * - 每个调用：`<tool_call:同一ID>工具名`，换行后 ` OPTIONS={JSON}`（单行紧凑）；
 * - 结束标签 `</tool_calls:ID>`。
 *
 * 模型在**未启用任何文本协议**时（目录缺 `supportsTools: false`，auto 模式因此
 * 不注入方言提示词）看到系统提示里的工具清单后自行输出了这套训练标记。既有的
 * 方言扫描器没有一个认识它，原始标签于是直接落进对话流：没有真正的工具调用，
 * 回合停在 `stopReason: "stop"`，模型在等一个永远不会到来的工具结果。
 *
 * ## 渲染约定
 *
 * 用**同一形状**回放，让模型继续它自己开的格式约定；工具结果走纯文本行
 * （`TOOL_RESULT[id] name` + 正文），因为 Hunyuan 的聊天模板对工具反馈没有
 * 结构化要求（与 kimi / minimax 那种自带 `<function_results>` 信封的方言不同）。
 */

import { parseJsonWithRepair } from "@musepi/pi-utils";
import type { Message, ToolCall } from "../types";
import { partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./hunyuan.md" with { type: "text" };
import { renderLegacyTextTranscript, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
} from "./types";

const BATCH_OPEN = "<tool_calls:";
const CALL_OPEN = "<tool_call:";

type State = "outside" | "batch";

/**
 * 流式扫描器。
 *
 * 与 kimi.ts 同骨架（buffer + state + `#consume` 循环），但结构更平：
 * 外层只有一个 batch 状态，每个调用在 `#consumeBatch` 里**一次性**解析完
 * （名字行 + OPTIONS 行），因为 Hunyuan 的载荷是单行 JSON、不需要增量拼参数。
 * 只有「JSON 还没流完」这一种情况要等下一块。
 */
export class HunyuanInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#batchId = "";

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			const progressed =
				this.#state === "outside" ? this.#consumeOutside(final, events) : this.#consumeBatch(final, events);
			if (!progressed) break;
		}
		if (final && this.#buffer.length > 0) {
			// 收尾时残留的字节是纯文本（半截调用不算调用）。
			events.push({ type: "text", text: this.#buffer });
			this.#buffer = "";
		}
		return events;
	}

	/** `outside`：找 batch 开标签；之前的文本原样透传。 */
	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const start = this.#buffer.indexOf(BATCH_OPEN);
		if (start === -1) {
			// 保留可能是标签前缀的尾部，其余作为文本发出。
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [BATCH_OPEN]);
			const emitEnd = this.#buffer.length - hold;
			if (emitEnd > 0) events.push({ type: "text", text: this.#buffer.slice(0, emitEnd) });
			this.#buffer = this.#buffer.slice(emitEnd);
			return false;
		}
		if (start > 0) {
			events.push({ type: "text", text: this.#buffer.slice(0, start) });
			this.#buffer = this.#buffer.slice(start);
		}
		const close = this.#buffer.indexOf(">");
		if (close === -1) return false; // 标签头还没流完
		this.#batchId = this.#buffer.slice(BATCH_OPEN.length, close).trim();
		this.#buffer = this.#buffer.slice(close + 1);
		this.#state = "batch";
		return true;
	}

	/** `batch`：解析一个调用或 batch 结束标签。 */
	#consumeBatch(final: boolean, events: InbandScanEvent[]): boolean {
		const batchClose = `</tool_calls:${this.#batchId}>`;
		const closeAt = this.#buffer.indexOf(batchClose);
		const callAt = this.#buffer.indexOf(CALL_OPEN);

		if (closeAt !== -1 && (callAt === -1 || closeAt < callAt)) {
			const before = this.#buffer.slice(0, closeAt);
			if (before.trim().length > 0) events.push({ type: "text", text: before });
			this.#buffer = this.#buffer.slice(closeAt + batchClose.length);
			this.#state = "outside";
			this.#batchId = "";
			return true;
		}
		if (callAt === -1) {
			if (final) return false; // 收尾时交给 #consume 兜底成文本
			// 只保留可能是结束标签/调用开标签的前缀。
			const hold = partialSuffixOverlapAny(this.#buffer, [batchClose, CALL_OPEN]);
			if (hold === 0) return false;
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return false;
		}
		if (callAt > 0) {
			// 调用之间的空白属于信封，丢弃。
			this.#buffer = this.#buffer.slice(callAt);
		}
		return this.#consumeCall(final, events);
	}

	/**
	 * 解析 `<tool_call:ID>name\n OPTIONS={json}`。
	 *
	 * 返回 false = 数据还不够（等下一块 SSE），true = 消耗了一次调用。
	 */
	#consumeCall(final: boolean, events: InbandScanEvent[]): boolean {
		const headerClose = this.#buffer.indexOf(">");
		if (headerClose === -1) return false;
		const callId = this.#buffer.slice(CALL_OPEN.length, headerClose).trim();
		const rest = this.#buffer.slice(headerClose + 1);
		const nameEnd = rest.indexOf("\n");
		if (nameEnd === -1) {
			if (!final) return false;
			// 名字行没流完：不是调用，交回文本。
			return false;
		}
		const name = rest.slice(0, nameEnd).trim();
		if (name === "") {
			// 空名字的标签不是调用：吃掉标签头，剩下的按文本走。
			this.#buffer = rest.slice(nameEnd + 1);
			events.push({ type: "text", text: `${CALL_OPEN}${callId}>` });
			return true;
		}
		const optionsLine = rest.slice(nameEnd + 1);
		const optionsAt = optionsLine.indexOf("OPTIONS=");
		if (optionsAt === -1) {
			if (!final) return false; // OPTIONS 行可能被 SSE 切开
			// 只有名字没有参数：按空参调用处理（模型漏了载荷）。
			this.#buffer = "";
			this.#emitCall(callId, name, {}, "", events);
			return true;
		}
		if (optionsLine.slice(0, optionsAt).trim() !== "") {
			// 名字与 OPTIONS 之间有垃圾：不是本格式，按文本透传。
			this.#buffer = "";
			events.push({ type: "text", text: `${CALL_OPEN}${callId}>${rest}` });
			return true;
		}
		const jsonText = optionsLine.slice(optionsAt + "OPTIONS=".length);
		const parsed = this.#scanJson(jsonText);
		if (parsed === undefined) {
			if (!final) return false; // JSON 还没流完
			// 收尾时半截 JSON 不是调用。
			this.#buffer = "";
			events.push({ type: "text", text: `${CALL_OPEN}${callId}>${rest}` });
			return true;
		}
		this.#buffer = parsed.rest;
		this.#emitCall(callId, name, parsed.args, parsed.source, events);
		return true;
	}

	#emitCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		source: string,
		events: InbandScanEvent[],
	): void {
		// 调用 id 用模型自己写的那个（batch 内稳定），空则退回 batch id。
		const id = callId === "" ? this.#batchId : callId;
		events.push({ type: "toolStart", id, name });
		events.push({
			type: "toolEnd",
			id,
			name,
			arguments: args,
			rawBlock: `${CALL_OPEN}${callId}>${name}\n OPTIONS=${source}`,
		});
	}

	/**
	 * 从单行文本里切出一个完整 JSON 对象。
	 *
	 * 返回 `undefined` = 还没闭合（等更多数据）。深度计数认字符串里的花括号与
	 * 转义，所以 `{"a":"}{"}` 也能正确闭合。
	 */
	#scanJson(text: string): { args: Record<string, unknown>; source: string; rest: string } | undefined {
		const braceAt = text.indexOf("{");
		if (braceAt === -1) {
			const trimmed = text.trim();
			if (trimmed === "") {
				// `OPTIONS=` has arrived but the object has not started: the payload
				// is still in flight. Returning empty args here would swallow the
				// JSON that follows in the next chunk (the call lands with `{}`).
				return undefined;
			}
			if (trimmed === "null") return { args: {}, source: "", rest: "" };
			// Anything else is not the format we parse; the caller turns it back
			// into text rather than inventing a call.
			return { args: {}, source: "", rest: "" };
		}
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = braceAt; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (ch === "{") depth += 1;
			else if (ch === "}") {
				depth -= 1;
				if (depth !== 0) continue;
				const source = text.slice(braceAt, i + 1);
				let args: Record<string, unknown>;
				try {
					args = JSON.parse(source) as Record<string, unknown>;
				} catch {
					// 模型偶尔写出尾随逗号等近失 JSON，修一次而不是丢掉整次调用。
					args = parseJsonWithRepair(source) as Record<string, unknown>;
				}
				const after = text.slice(i + 1);
				return { args, source, rest: after.replace(/^[ \t]*\r?\n/, "") };
			}
		}
		return undefined;
	}
}

/** 8 位十六进制调用 id：由工具名 + 参数派生，同一批调用共用一个。 */
function stableCallId(call: ToolCall): string {
	let hash = 0x6124c78e;
	const seed = `${call.name}\u0000${stringifyJson(call.arguments)}`;
	for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function renderToolCall(call: ToolCall): string {
	return `${CALL_OPEN}${stableCallId(call)}>${call.name}\n OPTIONS=${stringifyJson(call.arguments)}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[]): string {
	if (calls.length === 0) return "";
	const id = stableCallId(calls[0]!);
	const body = calls
		.map(call => `${CALL_OPEN}${id}>${call.name}\n OPTIONS=${stringifyJson(call.arguments)}`)
		.join("\n");
	return `${BATCH_OPEN}${id}>\n${body}\n</tool_calls:${id}>`;
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	// Hunyuan 的工具反馈是纯文本行（没有信封结构），id 保留以便模型对上调用。
	return results.map(result => `TOOL_RESULT[${result.id}] ${result.name}\n${result.text}`).join("\n\n");
}

function renderThinking(text: string): string {
	return `<think>\n${text}\n</think>`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderLegacyTextTranscript(messages, options, {
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResults: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "hunyuan",
	prompt: dialectPrompt,
	createScanner: () => new HunyuanInbandScanner(),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
