import "./happy-dom-shim";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { DisplayContext } from "@musepi/pi-wire";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dispatchAnnotationAttach } from "../../../packages/client-core/src/annotation/attach";
import { UserMsgContent } from "../../../packages/client-core/src/components/transcript/transcript-content";
import { Composer } from "../src/components/Composer";
import { QuoteCards } from "../src/components/composer/quote-cards";
import { WelcomeComposer } from "../src/components/WelcomeComposer";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

const annotation: DisplayContext = {
	kind: "browser-annotation",
	pageUrl: "https://example.com/docs",
	prompt:
		"Browser annotation:\nPage: Docs\nComment: old comment\n\nElement 1: button\nRegion 1: x=1, y=2, width=3, height=4",
	comment: "old comment",
	image: "data:image/png;base64,cG5n",
};

const rpc = {
	request: async () => null,
	addEventListener: () => () => {},
} as unknown as RpcClient;

const mounted = new Set<Root>();

// WelcomeComposer's BlurText reveal is a timer-driven mount animation; these
// assertions do not depend on it, so run the file with motion disabled and
// keep the timer out of unrelated act boundaries.
beforeAll(() => {
	document.documentElement.classList.add("gui-motion-off");
});

afterAll(() => {
	document.documentElement.classList.remove("gui-motion-off");
});

async function mount(element: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(element));
	return container;
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.localStorage.clear();
});

function SessionComposerFixture(): ReactNode {
	const [quotes, setQuotes] = useState<DisplayContext[]>([]);
	return (
		<Composer
			working={false}
			onSend={() => {}}
			onStop={() => {}}
			rpc={rpc}
			sessionId="s1"
			quotes={quotes}
			onQuotesChange={setQuotes}
		/>
	);
}

describe("annotation composer contexts", () => {
	it("attaches a browser annotation without writing its prompt into the session textarea", async () => {
		const container = await mount(<SessionComposerFixture />);
		await act(async () => dispatchAnnotationAttach({ text: annotation.prompt, displayContext: annotation }));
		expect(container.querySelector("textarea")?.value).toBe("");
		expect(container.querySelector(".gui-quote-chip")).not.toBeNull();
		expect(container.querySelector(".gui-quote-card")).toBeNull();
	});

	it("attaches a browser annotation without writing its prompt into the welcome textarea", async () => {
		window.localStorage.setItem("musepi-gui-dotmatrix", "0");
		const container = await mount(<WelcomeComposer onSubmit={() => {}} rpc={rpc} />);
		await act(async () => dispatchAnnotationAttach({ text: annotation.prompt, displayContext: annotation }));
		expect(container.querySelector("textarea")?.value).toBe("");
		expect(container.querySelector(".gui-quote-chip")).not.toBeNull();
		expect(container.querySelector(".gui-quote-card")).toBeNull();
	});

	it("groups mixed sources into compact chips and keeps details in their popup", async () => {
		const container = await mount(
			<QuoteCards
				contexts={[
					{ kind: "file-quote", path: "src/a.ts", quote: "const a = 1", startLine: 1, endLine: 1 },
					{
						kind: "file-quote",
						path: "docs/b.pdf",
						quote: "PDF text",
						pdf: { startPage: 1, endPage: 2, startIndex: 2, endIndex: 8, selections: [] },
					},
					{ kind: "chat-quote", quote: "chat text" },
					annotation,
				]}
				onRemove={() => {}}
				onChange={() => {}}
			/>,
		);
		expect(container.querySelectorAll(".gui-quote-chip")).toHaveLength(3);
		expect(container.querySelector(".gui-quote-card")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[data-quote-kind="file-quote"]')?.click());
		expect(document.querySelectorAll(".gui-quote-card")).toHaveLength(2);
		expect(document.querySelector('[data-quote-kind="file-quote"] .gui-quote-chip-count')?.textContent).toBe("2");
	});

	it("shows page and target count, previews, and removes the chip", async () => {
		let removed = -1;
		const container = await mount(
			<QuoteCards
				contexts={[annotation]}
				onRemove={index => {
					removed = index;
				}}
				onChange={() => {}}
			/>,
		);
		await act(async () => container.querySelector<HTMLButtonElement>(".gui-quote-chip")?.click());
		expect(document.querySelector(".gui-quote-context-page")?.textContent).toContain("example.com");
		expect(document.querySelector(".gui-quote-context-count")?.textContent).toBe("2");
		await act(async () => document.querySelector<HTMLButtonElement>(".gui-quote-preview")?.click());
		expect(document.querySelector<HTMLImageElement>(".gui-quote-context-image")?.src).toContain("data:image/png");
		await act(async () => document.querySelector<HTMLButtonElement>(".gui-quote-close")?.click());
		expect(removed).toBe(0);
	});
});

describe("transcript display contexts", () => {
	it("renders the dedicated quote card with source, clamp, comment, expansion, and source jump", async () => {
		let jump = "";
		const context: DisplayContext = {
			kind: "chat-quote",
			messageId: "assistant-1",
			quote: "a long quote\nwith several lines\nof source text",
			comment: "please fix this",
		};
		const container = await mount(
			<UserMsgContent
				content="> a long quote\n> with several lines\n> of source text\n\nplease fix this"
				displayContext={context}
				plain={false}
				collapse={false}
				onJumpToMessage={id => {
					jump = id;
				}}
			/>,
		);
		expect(container.querySelector(".tr-display-context")).not.toBeNull();
		expect(container.querySelector(".tr-display-context-source")?.textContent).not.toBe("");
		expect(container.querySelector(".tr-display-context-quote--clamped")).not.toBeNull();
		expect(container.querySelector(".tr-display-context-comment")?.textContent).toBe("please fix this");
		await act(async () => container.querySelector<HTMLButtonElement>(".tr-display-context-toggle")?.click());
		expect(container.querySelector(".tr-display-context-quote--clamped")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".tr-display-context-source")?.click());
		expect(jump).toBe("assistant-1");
	});

	it("does not mistake an ordinary markdown blockquote for a display context", async () => {
		const container = await mount(<UserMsgContent content="> ordinary quote" plain={false} collapse={false} />);
		expect(container.querySelector("blockquote")).not.toBeNull();
		expect(container.querySelector(".tr-display-context")).toBeNull();
	});

	it("keeps displayContext on the optimistic user entry", () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
		store.optimisticEcho("> quoted\n\nbody", undefined, { kind: "chat-quote", quote: "quoted" });
		const entries = store.getSnapshot().entries;
		const last = entries.at(-1);
		expect(last?.type).toBe("message");
		if (last?.type !== "message" || last.message.role !== "user") throw new Error("missing optimistic user message");
		expect(last.message.displayContext).toEqual({ kind: "chat-quote", quote: "quoted" });
	});
});
