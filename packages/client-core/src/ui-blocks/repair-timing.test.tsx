import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AssistantMessage } from "@musepi/pi-wire";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../components/transcript/Markdown";
import { AssistantBody, ThinkingBlock, UserText } from "../components/transcript/transcript-content";
import { applyAnswers, handleAnswerClick, UI_BLOCK_ANSWER_EVENT } from "./answers";
import { renderUiBlockFence } from "./render";

/**
 * Repair is a turn, not a render tick. A reply that is still growing must not
 * expose diagnostics or an action, one block must spend its repair once, and
 * only the assistant's answer publishes diagnostics at all.
 */

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
	void GlobalRegistrator.unregister();
});

const dispatched: string[] = [];
const onAnswer = (event: Event): void => {
	const detail = (event as CustomEvent<{ text?: unknown }>).detail;
	if (typeof detail?.text === "string" && detail.text) dispatched.push(detail.text);
};
window.addEventListener(UI_BLOCK_ANSWER_EVENT, onAnswer);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function renderClient(node: ReactNode): HTMLDivElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

/** Thinking bodies live in a closed fold: open it before reading the body. */
async function openThinking(container: HTMLDivElement): Promise<void> {
	const toggle = container.querySelector<HTMLButtonElement>(".tr-think-head");
	expect(toggle).not.toBeNull();
	act(() => toggle?.click());
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	dispatched.length = 0;
	document.body.innerHTML = "";
	window.localStorage.clear();
});

const TEST_TOOL_POLICY = { lane: "workbench", hidden: false, summarize: false } as const;

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
		const live = renderToStaticMarkup(<Markdown text={brokenFence} pending repair="reply" />);
		expect(live).toContain("tr-ui--streaming");
		expect(live).toContain("a");
		expect(live).not.toContain("tr-ui-note");
		expect(live).not.toContain("data-ui-repair");
	});

	test("the same block exposes one repair once the reply has settled", () => {
		const settled = renderToStaticMarkup(<Markdown text={brokenFence} repair="reply" />);
		expect(settled).toContain("data-ui-repair");
		expect(settled.match(/data-ui-repair/g) ?? []).toHaveLength(1);
	});

	test("a settled message inside a running turn keeps its note; only a pending reply hides it", () => {
		// `pending` is message-scoped. A turn-level flag must not freeze an
		// already-final answer's diagnostics — it only holds back the auto repair.
		const working = renderToStaticMarkup(
			<AssistantBody
				toolPolicy={TEST_TOOL_POLICY}
				message={assistantMessage(brokenFence)}
				results={new Map()}
				active={new Map()}
				pending={false}
				working
			/>,
		);
		expect(working).toContain("data-ui-repair");
		const live = renderToStaticMarkup(
			<AssistantBody
				toolPolicy={TEST_TOOL_POLICY}
				message={assistantMessage(brokenFence)}
				results={new Map()}
				active={new Map()}
				pending
			/>,
		);
		expect(live).not.toContain("data-ui-repair");
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

describe("diagnostics belong to the reply body only", () => {
	test("a host that does not opt in publishes nothing", () => {
		// Doc previews, announcements and every other `<Markdown>` host keep the
		// default: a broken ui example is content, not a failure to repair.
		const html = renderToStaticMarkup(<Markdown text={brokenFence} />);
		expect(html).not.toContain("data-ui-repair");
		expect(html).not.toContain("tr-ui-note");
		expect(html).not.toContain("tr-ui-src");
	});

	test("a thinking draft that is still streaming names no truncation", async () => {
		const host = renderClient(<ThinkingBlock text={"draft\n```ui\nroot = Stack(["} streaming />);
		await openThinking(host);
		expect(host.querySelector(".tr-md")).not.toBeNull();
		expect(host.querySelector(".tr-ui-note")).toBeNull();
		expect(host.querySelector(".tr-ui--truncated")).toBeNull();
		expect(host.querySelector("[data-ui-repair]")).toBeNull();
		expect(dispatched).toHaveLength(0);
	});

	test("a settled thinking block never offers a repair or sends one", async () => {
		const host = renderClient(<ThinkingBlock text={brokenFence} />);
		await openThinking(host);
		// The body is really mounted: the same fence draws a block, silently.
		expect(host.querySelector(".tr-ui")).not.toBeNull();
		expect(host.querySelector(".tr-ui-note")).toBeNull();
		expect(host.querySelector("[data-ui-repair]")).toBeNull();
		expect(dispatched).toHaveLength(0);
	});

	test("a closed broken fence in a streaming thinking block never sends a repair", async () => {
		// The exact mid-generation shape: a complete-but-invalid draft inside the
		// assistant's own thinking stream, rendered while the turn still runs.
		const source = '```ui\nroot = Stack([Stat("c", 1), Stat("d")])\n```';
		const host = renderClient(<ThinkingBlock text={source} streaming />);
		await openThinking(host);
		expect(host.querySelector("[data-ui-repair]")).toBeNull();
		expect(host.querySelector(".tr-ui-note")).toBeNull();
		expect(dispatched).toHaveLength(0);
	});

	test("the user's own unfinished example stays text with no note", () => {
		const host = renderClient(<UserText text={"示例：\n```ui\nroot = Stack(["} plain={false} collapse={false} />);
		expect(host.querySelector(".tr-ui--truncated")).toBeNull();
		expect(host.querySelector(".tr-ui-note")).toBeNull();
		expect(host.querySelector("[data-ui-repair]")).toBeNull();
	});
});

describe("the automatic repair waits for the turn", () => {
	const autoFence = '```ui\nroot = Stack([Stat("x", 1), Stat("y")])\n```\n';
	test("a pending reply sends nothing; the settled one sends once", () => {
		const message = assistantMessage(autoFence);
		const host = renderClient(
			<AssistantBody
				toolPolicy={TEST_TOOL_POLICY}
				message={message}
				results={new Map()}
				active={new Map()}
				pending
			/>,
		);
		expect(host.querySelector("[data-ui-repair]")).toBeNull();
		expect(dispatched).toHaveLength(0);

		act(() =>
			root?.render(
				<AssistantBody
					toolPolicy={TEST_TOOL_POLICY}
					message={message}
					results={new Map()}
					active={new Map()}
					pending={false}
				/>,
			),
		);
		expect(host.querySelectorAll("[data-ui-repair]")).toHaveLength(1);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]).toContain('Stat("x", 1), Stat("y")');

		// One commit later the same answer is drawn again: the repair is spent.
		act(() =>
			root?.render(
				<AssistantBody
					toolPolicy={TEST_TOOL_POLICY}
					message={message}
					results={new Map()}
					active={new Map()}
					pending={false}
				/>,
			),
		);
		expect(dispatched).toHaveLength(1);
	});

	test("a settled reply inside a running turn keeps its diagnostics without sending", () => {
		// `pending` is message-scoped: this answer is final, the agent is just on
		// a later step. The failure note stays, the automatic repair waits.
		const host = renderClient(
			<AssistantBody
				toolPolicy={TEST_TOOL_POLICY}
				message={assistantMessage(brokenFence)}
				results={new Map()}
				active={new Map()}
				pending={false}
				working
			/>,
		);
		expect(host.querySelectorAll("[data-ui-repair]")).toHaveLength(1);
		expect(host.querySelector(".tr-ui--streaming")).toBeNull();
		expect(dispatched).toHaveLength(0);
	});
});
