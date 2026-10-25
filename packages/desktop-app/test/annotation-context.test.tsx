import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { DisplayContext } from "@musepi/pi-wire";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dispatchAnnotationAttach } from "../../client-core/src/annotation/attach";
import { UserMsgContent } from "../../client-core/src/components/transcript/transcript-content";
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

function mount(element: ReactNode): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	act(() => root.render(element));
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
	it("attaches a browser annotation without writing its prompt into the session textarea", () => {
		const container = mount(<SessionComposerFixture />);
		act(() => dispatchAnnotationAttach({ text: annotation.prompt, displayContext: annotation }));
		expect(container.querySelector("textarea")?.value).toBe("");
		expect(container.querySelector(".gui-quote-card")).not.toBeNull();
	});

	it("attaches a browser annotation without writing its prompt into the welcome textarea", () => {
		window.localStorage.setItem("musepi-gui-dotmatrix", "0");
		const container = mount(<WelcomeComposer onSubmit={() => {}} rpc={rpc} />);
		act(() => dispatchAnnotationAttach({ text: annotation.prompt, displayContext: annotation }));
		expect(container.querySelector("textarea")?.value).toBe("");
		expect(container.querySelector(".gui-quote-card")).not.toBeNull();
	});

	it("shows page and target count, previews, and removes the chip", () => {
		let removed = -1;
		const container = mount(
			<QuoteCards
				contexts={[annotation]}
				onRemove={index => {
					removed = index;
				}}
				onChange={() => {}}
			/>,
		);
		expect(container.querySelector(".gui-quote-context-page")?.textContent).toContain("example.com");
		expect(container.querySelector(".gui-quote-context-count")?.textContent).toBe("2");
		act(() => container.querySelector<HTMLButtonElement>(".gui-quote-preview")?.click());
		expect(container.querySelector<HTMLImageElement>(".gui-quote-context-image")?.src).toContain("data:image/png");
		act(() => container.querySelector<HTMLButtonElement>(".gui-quote-close")?.click());
		expect(removed).toBe(0);
	});
});

describe("transcript display contexts", () => {
	it("renders the dedicated quote card with source, clamp, comment, expansion, and source jump", () => {
		let jump = "";
		const context: DisplayContext = {
			kind: "chat-quote",
			messageId: "assistant-1",
			quote: "a long quote\nwith several lines\nof source text",
			comment: "please fix this",
		};
		const container = mount(
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
		act(() => container.querySelector<HTMLButtonElement>(".tr-display-context-toggle")?.click());
		expect(container.querySelector(".tr-display-context-quote--clamped")).toBeNull();
		act(() => container.querySelector<HTMLButtonElement>(".tr-display-context-source")?.click());
		expect(jump).toBe("assistant-1");
	});

	it("does not mistake an ordinary markdown blockquote for a display context", () => {
		const container = mount(<UserMsgContent content="> ordinary quote" plain={false} collapse={false} />);
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
