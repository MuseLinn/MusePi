import { beforeEach, describe, expect, test } from "bun:test";
import {
	composeAnswer,
	handleAnswerClick,
	isSent,
	openTab,
	sendAnswer,
	setAnswer,
	setCardNote,
	setNote,
	UI_BLOCK_ANSWER_EVENT,
} from "./answers";

/**
 * The store is what a reply's controls answer into. It is keyed by block hash so
 * two blocks on screen cannot answer each other, and it composes ONE message so
 * four choices do not become four turns.
 */

interface Sent {
	text: string;
}

const dispatched: Sent[] = [];

beforeEach(() => {
	dispatched.length = 0;
	(globalThis as { window?: unknown }).window = {
		dispatchEvent: (event: CustomEvent<{ text: string }>) => {
			if (event.type === UI_BLOCK_ANSWER_EVENT) dispatched.push(event.detail);
			return true;
		},
	};
});

describe("answers", () => {
	test("an empty block composes nothing", () => {
		expect(composeAnswer("empty")).toBe("");
	});

	test("a choice and a note become one message", () => {
		setAnswer("a", "deploy", "今晚", "部署窗口");
		setNote("a", "先确认只读窗口");
		const text = composeAnswer("a");
		expect(text).toContain("部署窗口：今晚");
		expect(text).toContain("先确认只读窗口");
	});

	test("blocks do not answer each other", () => {
		setAnswer("a", "x", "one", "Q1");
		setAnswer("b", "x", "two", "Q1");
		expect(composeAnswer("a")).toContain("one");
		expect(composeAnswer("b")).toContain("two");
	});

	test("sending dispatches once and settles the block", () => {
		setAnswer("c", "pick", "先修这个", "#12 登录失败");
		expect(sendAnswer("c")).toBe(true);
		expect(sendAnswer("c")).toBe(true);
		expect(dispatched).toHaveLength(2);
		expect(isSent("c")).toBe(true);
	});

	test("an empty value clears the decision instead of answering blank", () => {
		setAnswer("d", "note", "有值", "Q");
		setAnswer("d", "note", "", "Q");
		expect(composeAnswer("d")).toBe("");
	});

	test("a card's note rides under the decision it qualifies", () => {
		setAnswer("note1", "card:数据库", "Postgres", "数据库");
		setAnswer("note1", "card:缓存", "Redis", "缓存");
		setCardNote("note1", "数据库", "要读副本");
		const text = composeAnswer("note1");
		// The condition is attached to its own option, indented, not pooled below.
		expect(text).toContain("- 数据库：Postgres\n  ");
		expect(text).toContain("要读副本");
		expect(text).not.toContain("- 缓存：Redis\n  ");
	});

	test("a card answered only with a condition still reaches the agent", () => {
		setCardNote("note2", "部署窗口", "先在预发验证");
		const text = composeAnswer("note2");
		expect(text).toContain("部署窗口");
		expect(text).toContain("先在预发验证");
	});

	test("an emptied card note is dropped, not sent as whitespace", () => {
		setAnswer("note3", "k", "v", "D");
		setCardNote("note3", "D", "临时");
		setCardNote("note3", "D", "   ");
		expect(composeAnswer("note3")).not.toContain("临时");
	});
});

describe("delegated clicks", () => {
	test("switching a tab page is remembered and answers nothing", () => {
		const host = { dataset: { uiBlock: "tabs1" } };
		const tab = {
			getAttribute: (name: string) =>
				name === "data-ui-tab" ? "概览\u0001明细" : name === "data-ui-tab-page" ? "明细" : null,
			closest: (selector: string) =>
				selector === "[data-ui-tab]" ? tab : selector === "[data-ui-block]" ? host : null,
		};
		expect(handleAnswerClick(tab as unknown as Element)).toBe(true);
		expect(openTab("tabs1", "概览\u0001明细")).toBe("明细");
		// Switching views must not compose a message: it answers nothing.
		expect(composeAnswer("tabs1")).toBe("");
	});

	test("a send affordance is consumed by its own block", () => {
		const host = { dataset: { uiBlock: "e" } };
		// `closest` returns the nearest MATCHING ancestor: a send button is not a
		// link row, and the mock has to say so or it stands in for both.
		const send = {
			closest: (selector: string) =>
				selector === "[data-ui-repair]" || selector === "[data-ui-link-send]" || selector === "[data-ui-tab]"
					? null
					: selector === "[data-ui-send]"
						? send
						: host,
		};
		setAnswer("e", "k", "v", "D");
		expect(handleAnswerClick(send as unknown as Element)).toBe(true);
		expect(isSent("e")).toBe(true);
	});

	test("a link with a message opens its page and sends the sentence once", () => {
		const opened: string[] = [];
		(globalThis as { window?: unknown }).window = {
			dispatchEvent: (event: CustomEvent<{ text?: string; url?: string }>) => {
				if (event.type === UI_BLOCK_ANSWER_EVENT && event.detail.text) dispatched.push({ text: event.detail.text });
				if (event.type === "musepi-open-url" && event.detail.url) opened.push(event.detail.url);
				return true;
			},
		};
		const host = { dataset: { uiBlock: "link1" } };
		const link = {
			getAttribute: (name: string) =>
				name === "data-ui-message" ? "已登录，继续" : name === "data-ui-href" ? "https://example.test/a" : null,
			closest: (selector: string) =>
				selector === "[data-ui-link-send]"
					? link
					: selector === "[data-ui-block]"
						? host
						: selector === "[data-ui-repair]"
							? null
							: null,
		};
		expect(handleAnswerClick(link as unknown as Element)).toBe(true);
		expect(opened).toEqual(["https://example.test/a"]);
		expect(dispatched.at(-1)?.text).toBe("已登录，继续");
		// The same row is spent: a redraw must not send a second turn.
		expect(handleAnswerClick(link as unknown as Element)).toBe(true);
		expect(dispatched).toHaveLength(1);
	});
});

describe("repairing a block that never drew", () => {
	test("the repair message quotes the source and the reasons", async () => {
		const { rememberBlockFailure, handleAnswerClick, UI_BLOCK_ANSWER_EVENT } = await import("./answers");
		rememberBlockFailure("broken", 'root = Stack([Card(title: "x")])', ["title: arguments are positional"]);
		const button = {
			getAttribute: (name: string) => (name === "data-ui-repair" ? "broken" : null),
			closest: (selector: string) => (selector === "[data-ui-repair]" ? button : null),
		};
		expect(handleAnswerClick(button as unknown as Element)).toBe(true);
		const sent = dispatched.at(-1)?.text ?? "";
		expect(sent).toContain('root = Stack([Card(title: "x")])');
		expect(sent).toContain("arguments are positional");
		expect(UI_BLOCK_ANSWER_EVENT).toBe("musepi-ui-block-answer");
	});

	test("a repair for a block this build never saw does nothing", async () => {
		const { handleAnswerClick } = await import("./answers");
		const button = {
			getAttribute: () => "unknown-hash",
			closest: (selector: string) => (selector === "[data-ui-repair]" ? button : null),
		};
		expect(handleAnswerClick(button as unknown as Element)).toBe(false);
	});
});

describe("automatic repair", () => {
	test("one failed signature repairs once, then stops", async () => {
		const { rememberBlockFailure, maybeAutoRepair, UI_BLOCK_ANSWER_EVENT } = await import("./answers");
		const store = new Map<string, string>();
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		};
		dispatched.length = 0;
		rememberBlockFailure("auto1", 'root = Stack([Card(title: "x")])', ["unexpected token ("]);
		expect(maybeAutoRepair("auto1")).toBe(true);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.text).toContain('root = Stack([Card(title: "x")])');
		// the same failure, seen again after a re-render or a reload, must not loop
		expect(maybeAutoRepair("auto1")).toBe(false);
		expect(dispatched).toHaveLength(1);
		expect(UI_BLOCK_ANSWER_EVENT).toBe("musepi-ui-block-answer");
	});

	test("a different failure gets its own single attempt", async () => {
		const { rememberBlockFailure, maybeAutoRepair } = await import("./answers");
		rememberBlockFailure("auto2", "root = Stack([Bogus()])", ["unknown component Bogus"]);
		expect(maybeAutoRepair("auto2")).toBe(true);
	});

	test("a block this build never saw is not repaired", async () => {
		const { maybeAutoRepair } = await import("./answers");
		expect(maybeAutoRepair("never-seen")).toBe(false);
	});

	test("several failed blocks in one reply cost one request, then none", async () => {
		const { rememberBlockFailure, autoRepairFailedBlocks } = await import("./answers");
		const store = new Map<string, string>();
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		};
		dispatched.length = 0;
		rememberBlockFailure("batch1", 'root = Stack([Bogus("one")])', ["unknown component Bogus (one)"]);
		rememberBlockFailure("batch2", 'root = Stack([Bogus("two")])', ["unknown component Bogus (two)"]);
		const root = {
			querySelectorAll: () => [
				{ getAttribute: (name: string) => (name === "data-ui-repair" ? "batch1" : null) },
				{ getAttribute: (name: string) => (name === "data-ui-repair" ? "batch2" : null) },
			],
		};
		autoRepairFailedBlocks(root as unknown as ParentNode);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.text).toContain('Bogus("one")');
		expect(dispatched[0]?.text).toContain('Bogus("two")');
		// One commit later the same buttons are still in the DOM; the batch has
		// already spent its single chance.
		autoRepairFailedBlocks(root as unknown as ParentNode);
		expect(dispatched).toHaveLength(1);
	});
});
