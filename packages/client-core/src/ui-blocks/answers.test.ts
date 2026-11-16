import { beforeEach, describe, expect, test } from "bun:test";
import {
	composeAnswer,
	handleAnswerClick,
	isSent,
	sendAnswer,
	setAnswer,
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
});

describe("delegated clicks", () => {
	test("a send affordance is consumed by its own block", () => {
		const host = { dataset: { uiBlock: "e" } };
		const send = {
			closest: (selector: string) =>
				selector === "[data-ui-repair]" ? null : selector === "[data-ui-send]" ? send : host,
		};
		setAnswer("e", "k", "v", "D");
		expect(handleAnswerClick(send as unknown as Element)).toBe(true);
		expect(isSent("e")).toBe(true);
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
});
