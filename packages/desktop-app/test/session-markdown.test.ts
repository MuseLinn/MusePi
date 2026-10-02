import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildSessionMarkdown, type MarkdownLabels, markdownFileName } from "../src/lib/session-markdown";

/**
 * Session → Markdown export.
 *
 * The failure this defends: the export filtered to `type === "message"`, so a
 * session with advisor notes produced a Markdown file with every card silently
 * gone — no placeholder, no error, and the re-shared transcript no longer
 * explained what happened. The second failure is quieter still: reading text
 * from the wrong field exports the model-facing `<advisory severity=…>` XML
 * instead of the note.
 */

const LABELS: MarkdownLabels = {
	user: "用户",
	assistant: "助手",
	advisor: "顾问",
};

let seq = 0;
function nextId(): string {
	seq += 1;
	return `e${seq}`;
}
function user(text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: "2026-10-03T00:00:00.000Z",
		message: { role: "user", timestamp: 1, content: text },
	} as unknown as SessionEntry;
}
function assistant(text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: "2026-10-03T00:00:01.000Z",
		message: {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text }],
		},
	} as unknown as SessionEntry;
}
function toolResult(text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: "2026-10-03T00:00:02.000Z",
		message: {
			role: "toolResult",
			timestamp: 3,
			content: text,
			toolName: "bash",
		},
	} as unknown as SessionEntry;
}
/** Real advisor shape: XML in `content`, human text in `details.notes[].note`. */
function advisor(note: string, display = true): SessionEntry {
	return {
		type: "custom_message",
		id: nextId(),
		parentId: null,
		timestamp: "2026-10-03T00:00:03.000Z",
		customType: "advisor",
		display,
		content: `<advisory severity="concern" guidance="weigh">${note}</advisory>`,
		details: { notes: [{ note, severity: "concern" }] },
		attribution: "agent",
	} as unknown as SessionEntry;
}

describe("buildSessionMarkdown", () => {
	test("exports advisor cards — a message-only filter dropped them silently", () => {
		const md = buildSessionMarkdown("优化时间范围", [user("问题"), advisor("ms→points 要用 round()")], LABELS);
		expect(md).toContain("ms→points 要用 round()");
		expect(md).toContain("## 顾问");
	});

	test("exports the note text, never the model-facing XML", () => {
		const md = buildSessionMarkdown("t", [advisor("别用 floor")], LABELS);
		expect(md).not.toContain("<advisory");
		expect(md).not.toContain("severity=");
		expect(md).not.toContain("guidance=");
	});

	test("keeps a hidden advisor note out", () => {
		const md = buildSessionMarkdown("t", [user("q"), advisor("内部的计划推 nudge", false)], LABELS);
		expect(md).not.toContain("nudge");
	});

	test("keeps user and assistant prose, in order, and skips tool results", () => {
		const md = buildSessionMarkdown(
			"t",
			[user("第一个问题"), assistant("第一答"), toolResult("bash output"), user("第二个问题")],
			LABELS,
		);
		expect(md).toContain("## 用户\n\n第一个问题");
		expect(md).toContain("## 助手\n\n第一答");
		expect(md).toContain("第二个问题");
		expect(md).not.toContain("bash output");
		expect(md.indexOf("第一个问题")).toBeLessThan(md.indexOf("第一答"));
	});

	test("joins multiple notes so none is lost", () => {
		const multi = {
			...advisor("first"),
			details: {
				notes: [{ note: "第一条" }, { note: "  " }, { note: "第二条" }],
			},
		} as SessionEntry;
		const md = buildSessionMarkdown("t", [multi], LABELS);
		expect(md).toContain("第一条; 第二条");
	});

	test("skips bookkeeping entries but keeps the conversation", () => {
		const md = buildSessionMarkdown(
			"t",
			[
				{
					type: "model_change",
					id: "m1",
					parentId: null,
					timestamp: "x",
					model: "m",
				} as unknown as SessionEntry,
				user("q"),
				{
					type: "label",
					id: "l1",
					parentId: null,
					timestamp: "x",
					targetId: "e1",
					label: "x",
				} as unknown as SessionEntry,
			],
			LABELS,
		);
		expect(md).toContain("q");
		expect(md).not.toContain("model_change");
	});

	test("an advisor note with no notes payload exports as nothing, not as XML", () => {
		const bare = {
			type: "custom_message",
			id: "x",
			parentId: null,
			timestamp: "x",
			customType: "advisor",
			display: true,
			content: "<advisory>raw</advisory>",
		} as unknown as SessionEntry;
		const md = buildSessionMarkdown("t", [bare], LABELS);
		expect(md).not.toContain("raw");
		expect(md).not.toContain("## 顾问");
	});

	test("a session with no conversation still yields a titled document", () => {
		expect(buildSessionMarkdown("空会话", [], LABELS)).toBe("# 空会话\n");
	});
});

describe("markdownFileName", () => {
	test("keeps CJK and word characters, drops the rest", () => {
		expect(markdownFileName("优化 数据 输入/时间范围")).toBe("优化-数据-输入-时间范围");
	});

	test("falls back to a usable name instead of an empty one", () => {
		expect(markdownFileName("///")).toBe("session");
		expect(markdownFileName("")).toBe("session");
	});
});
