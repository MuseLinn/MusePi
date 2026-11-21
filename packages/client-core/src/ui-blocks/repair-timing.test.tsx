import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AssistantMessage } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../components/transcript/Markdown";
import { AssistantBody } from "../components/transcript/transcript-content";
import { applyAnswers, handleAnswerClick, UI_BLOCK_ANSWER_EVENT } from "./answers";
import { renderUiBlockFence } from "./render";

/**
 * Repair is a turn, not a render tick. A reply that is still growing must not
 * expose diagnostics or an action, and one block must spend its repair once.
 */

GlobalRegistrator.register();
afterAll(() => {
	void GlobalRegistrator.unregister();
});

const dispatched: string[] = [];
const onAnswer = (event: Event): void => {
	const detail = (event as CustomEvent<{ text?: unknown }>).detail;
	if (typeof detail?.text === "string" && detail.text) dispatched.push(detail.text);
};
window.addEventListener(UI_BLOCK_ANSWER_EVENT, onAnswer);

afterEach(() => {
	dispatched.length = 0;
	document.body.innerHTML = "";
});

const brokenFence = '```ui\nroot = Stack([Stat("a", 1), Stat("b")])\n```\n';

const assistantMessage = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	model: "test/model",
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 1,
});

describe("diagnostics follow the reply, not the markdown tick", () => {
	test("a closed but broken fence is quiet while the reply can still grow", () => {
		const live = renderToStaticMarkup(<Markdown text={brokenFence} pending />);
		expect(live).toContain("tr-ui--streaming");
		expect(live).toContain("a");
		expect(live).not.toContain("tr-ui-note");
		expect(live).not.toContain("data-ui-repair");
	});

	test("the same block exposes one repair once the reply has settled", () => {
		const settled = renderToStaticMarkup(<Markdown text={brokenFence} />);
		expect(settled).toContain("data-ui-repair");
		expect(settled.match(/data-ui-repair/g) ?? []).toHaveLength(1);
	});

	test("an idle message inside a running turn still waits for the turn", () => {
		// The 700ms markdown idle is not a finished reply: the block text is
		// final but the agent is still working, so its repair must stay hidden.
		const working = renderToStaticMarkup(
			<AssistantBody
				message={assistantMessage(brokenFence)}
				results={new Map()}
				active={new Map()}
				pending={false}
				working
			/>,
		);
		expect(working).not.toContain("data-ui-repair");
		const idle = renderToStaticMarkup(
			<AssistantBody
				message={assistantMessage(brokenFence)}
				results={new Map()}
				active={new Map()}
				pending={false}
			/>,
		);
		expect(idle).toContain("data-ui-repair");
	});
});

describe("one repair per block", () => {
	test("a second press does not send a second turn", () => {
		document.body.innerHTML = renderUiBlockFence('root = Stack([Card(title: "timing-1")])', { settled: true });
		const button = document.querySelector<HTMLButtonElement>("[data-ui-repair]");
		expect(button).not.toBeNull();
		expect(button?.disabled).toBe(false);

		expect(handleAnswerClick(button as Element)).toBe(true);
		expect(dispatched).toHaveLength(1);
		expect(button?.disabled).toBe(true);

		expect(handleAnswerClick(button as Element)).toBe(true);
		expect(dispatched).toHaveLength(1);
	});

	test("a redraw keeps a spent repair disabled", () => {
		document.body.innerHTML = renderUiBlockFence('root = Stack([Stat("a", 1), Stat("b")])', {
			settled: true,
		});
		const button = document.querySelector<HTMLButtonElement>("[data-ui-repair]");
		expect(button).not.toBeNull();
		handleAnswerClick(button as Element);

		applyAnswers(document);
		expect(button?.disabled).toBe(true);
		expect(button?.dataset.uiSent).toBe("true");
	});
});
