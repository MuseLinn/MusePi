import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PdfQuoteAnchor } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { rangeToMarkdown, type SelectionQuoteSource, SelectionToolbar } from "../src/components/SelectionToolbar";

const mounted = new Set<Root>();
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
	clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	else Reflect.deleteProperty(navigator, "clipboard");
});

describe("SelectionToolbar external selections", () => {
	it("routes one editor selection to the quote, ask, copy, session and note actions without DOM capture", async () => {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		const container = document.createElement("div");
		rootElement.appendChild(container);
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		const calls: string[] = [];
		const selection = { text: "selected\nsource", x: 140, y: 220, height: 20 };
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={{ current: container }}
					selection={selection}
					onQuote={text => calls.push(`quote:${text}`)}
					onAsk={(text, x, y) => calls.push(`ask:${text}:${x}:${y}`)}
					onCopy={text => calls.push(`copy:${text}`)}
					onNewSession={text => calls.push(`session:${text}`)}
					onAddNote={text => calls.push(`note:${text}`)}
				/>,
			),
		);
		const buttons = Array.from(rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-btn"));
		expect(buttons).toHaveLength(6);
		await act(async () => {
			for (const index of [0, 2, 3, 4, 5]) buttons[index]!.click();
		});
		expect(calls).toEqual([
			"quote:selected\nsource",
			"ask:selected\nsource:140:220",
			"copy:selected\nsource",
			"session:selected\nsource",
			"note:selected\nsource",
		]);
	});

	it("flips below a first-line selection instead of covering the file header", async () => {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		const container = document.createElement("div");
		container.getBoundingClientRect = () => ({ top: 200 }) as DOMRect;
		rootElement.appendChild(container);
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={{ current: container }}
					selection={{ text: "first line", x: 140, y: 210, height: 20 }}
					onQuote={() => {}}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			),
		);
		expect(rootElement.querySelector<HTMLElement>(".gui-select-pop")?.style.top).toBe("234px");
	});

	it("moves below a selection when the editor toolbar occupies the space above", async () => {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		const container = document.createElement("div");
		container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
		const editorToolbar = document.createElement("div");
		editorToolbar.className = "milkdown-toolbar";
		editorToolbar.getBoundingClientRect = () =>
			({ left: 60, right: 220, top: 170, bottom: 210, width: 160, height: 40 }) as DOMRect;
		container.appendChild(editorToolbar);
		rootElement.appendChild(container);
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={{ current: container }}
					selection={{ text: "selected text", x: 140, y: 220, height: 20 }}
					avoidSelector=".milkdown-toolbar"
					onQuote={() => {}}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			),
		);
		expect(rootElement.querySelector<HTMLElement>(".gui-select-pop")?.style.top).toBe("244px");
	});
});

describe("SelectionToolbar DOM selections", () => {
	it("binds after the pane container appears following the first render", async () => {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		const containerRef: { current: HTMLElement | null } = { current: null };
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={containerRef}
					onQuote={() => {}}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			),
		);

		// FilePane mounts the preview body only once a file is open.
		const container = document.createElement("div");
		const text = document.createTextNode("selected text");
		container.appendChild(text);
		document.body.appendChild(container);
		containerRef.current = container;
		const originalSelection = window.getSelection;
		window.getSelection = (() => ({
			isCollapsed: false,
			toString: () => "selected text",
			anchorNode: text,
			getRangeAt: () => ({
				getBoundingClientRect: () => ({ left: 100, top: 180, width: 80, height: 20 }),
				getClientRects: () => [{ left: 100, top: 180, width: 80, height: 20 }],
			}),
		})) as typeof window.getSelection;
		try {
			await act(async () => {
				text.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				await Bun.sleep(30);
			});
			expect(document.querySelector(".gui-select-pop")).not.toBeNull();
		} finally {
			window.getSelection = originalSelection;
		}
	});
	it("anchors a long DOM selection at the release point instead of its first line", async () => {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		const containerRef: { current: HTMLElement | null } = { current: null };
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={containerRef}
					onQuote={() => {}}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			),
		);
		const container = document.createElement("div");
		const text = document.createTextNode("a long multi-line selection");
		container.appendChild(text);
		document.body.appendChild(container);
		containerRef.current = container;
		const originalSelection = window.getSelection;
		window.getSelection = (() => ({
			isCollapsed: false,
			toString: () => "a long multi-line selection",
			anchorNode: text,
			getRangeAt: () => ({
				getBoundingClientRect: () => ({ left: 100, top: 180, width: 300, height: 160 }),
				getClientRects: () => [
					{ left: 100, top: 180, width: 300, height: 20 },
					{ left: 100, top: 320, width: 120, height: 20 },
				],
			}),
		})) as typeof window.getSelection;
		try {
			await act(async () => {
				text.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 212, clientY: 336 }));
				await Bun.sleep(30);
			});
			const pop = document.querySelector<HTMLElement>(".gui-select-pop");
			expect(pop).not.toBeNull();
			expect(Math.round(Number.parseFloat(pop!.style.top))).toBe(298);
			// The chip is centred on the pointer (plus the 8px viewport clamp
			// in happy-dom, where the unlaid-out rect reports x=0).
			expect(Math.round(Number.parseFloat(pop!.style.left))).toBe(220);
		} finally {
			window.getSelection = originalSelection;
		}
	});
});

describe("SelectionToolbar comment editor", () => {
	async function mountCommentToolbar(
		onQuote: (text: string, comment?: string, pdf?: PdfQuoteAnchor) => void,
		pdf?: PdfQuoteAnchor,
	): Promise<HTMLElement> {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		const container = document.createElement("div");
		rootElement.appendChild(container);
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={{ current: container }}
					selection={{ text: "selected\nsource", x: 140, y: 220, height: 20, ...(pdf ? { pdf } : {}) }}
					onQuote={(text, anchor, _office, comment) => onQuote(text, comment, anchor)}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			),
		);
		return rootElement;
	}

	function commentInput(rootElement: HTMLElement): HTMLInputElement {
		const input = rootElement.querySelector<HTMLInputElement>(".gui-select-pop-comment-input");
		if (!input) throw new Error("comment editor did not open");
		return input;
	}

	async function type(input: HTMLInputElement, value: string): Promise<void> {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
			const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
			const props = input[propsKey as keyof HTMLInputElement] as unknown as {
				onChange(event: { target: HTMLInputElement }): void;
			};
			props.onChange({ target: input });
			await Bun.sleep(0);
		});
	}

	async function openCommentEditor(rootElement: HTMLElement): Promise<void> {
		const commentButton = rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-btn")[1];
		if (!commentButton) throw new Error("comment action is missing");
		await act(async () => commentButton.click());
	}

	it("submits the selection with its comment on Enter", async () => {
		const quotes: Array<[string, string | undefined]> = [];
		const rootElement = await mountCommentToolbar((text, comment) => quotes.push([text, comment]));
		await openCommentEditor(rootElement);
		const input = commentInput(rootElement);
		expect(document.activeElement).toBe(input);
		const buttons = rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-comment button");
		expect(buttons[1]?.disabled).toBe(true);

		await type(input, "why does this fail?");
		expect(buttons[1]?.disabled).toBe(false);
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});

		expect(quotes).toEqual([["selected\nsource", "why does this fail?"]]);
		expect(rootElement.querySelector(".gui-select-pop-comment")).toBeNull();
		expect(rootElement.querySelector(".gui-select-pop")).not.toBeNull();
	});

	it("discards a draft on Cancel and leaves the toolbar up", async () => {
		const quotes: string[] = [];
		const rootElement = await mountCommentToolbar(text => quotes.push(text));
		await openCommentEditor(rootElement);
		await type(commentInput(rootElement), "draft");
		const cancel = rootElement.querySelector<HTMLButtonElement>(".gui-select-pop-comment button");
		await act(async () => cancel?.click());

		expect(quotes).toEqual([]);
		expect(rootElement.querySelector(".gui-select-pop-comment")).toBeNull();
		expect(rootElement.querySelector(".gui-select-pop--closing")).toBeNull();
	});

	it("closes only the comment editor on Escape", async () => {
		const rootElement = await mountCommentToolbar(() => {});
		await openCommentEditor(rootElement);
		const input = commentInput(rootElement);

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(rootElement.querySelector(".gui-select-pop-comment")).toBeNull();
		expect(rootElement.querySelector(".gui-select-pop--closing")).toBeNull();

		await act(async () => {
			document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(rootElement.querySelector(".gui-select-pop--closing")).not.toBeNull();
	});

	it("closes the comment editor on an outside click before dismissing the toolbar", async () => {
		const rootElement = await mountCommentToolbar(() => {});
		await openCommentEditor(rootElement);

		await act(async () => {
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(rootElement.querySelector(".gui-select-pop-comment")).toBeNull();
		expect(rootElement.querySelector(".gui-select-pop--closing")).toBeNull();

		await act(async () => {
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(rootElement.querySelector(".gui-select-pop--closing")).not.toBeNull();
	});

	it("forwards the editor anchor with the submitted comment", async () => {
		const pdf: PdfQuoteAnchor = { startPage: 2, endPage: 2, startIndex: 0, endIndex: 0, selections: [] };
		const calls: Array<{ text: string; comment?: string; pdf?: PdfQuoteAnchor }> = [];
		const rootElement = await mountCommentToolbar(
			(text, comment, anchor) => calls.push({ text, comment, pdf: anchor }),
			pdf,
		);
		await openCommentEditor(rootElement);
		const input = commentInput(rootElement);
		await type(input, "page note");
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});

		expect(calls).toEqual([{ text: "selected\nsource", comment: "page note", pdf }]);
	});

	it("keeps the draft when the pane reports the same selection again", async () => {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		const container = document.createElement("div");
		rootElement.appendChild(container);
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		const selection = { text: "same selection", x: 120, y: 240, height: 20 };
		const render = () =>
			root.render(
				<SelectionToolbar
					containerRef={{ current: container }}
					selection={{ ...selection }}
					onQuote={() => {}}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			);
		await act(async () => render());
		await act(async () => rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-btn")[1]?.click());
		await type(commentInput(rootElement), "draft");
		// FilePane rebuilds its selection object on every render; an identical
		// selection must not discard the comment being typed.
		await act(async () => render());

		expect(commentInput(rootElement).value).toBe("draft");
	});
});

/** A real Range plus the layout data a browser would report for it. */
function withLayout(range: Range): Range {
	const rect = { left: 100, top: 180, width: 120, height: 20 };
	return {
		startContainer: range.startContainer,
		startOffset: range.startOffset,
		endContainer: range.endContainer,
		endOffset: range.endOffset,
		commonAncestorContainer: range.commonAncestorContainer,
		cloneContents: () => range.cloneContents(),
		toString: () => range.toString(),
		getBoundingClientRect: () => rect,
		getClientRects: () => [rect],
	} as unknown as Range;
}

function mountMarkdown(html: string): HTMLElement {
	document.body.innerHTML = `<div class="tr-md">${html}</div>`;
	const root = document.querySelector<HTMLElement>(".tr-md");
	if (!root) throw new Error("markdown fixture did not mount");
	return root;
}

describe("rangeToMarkdown", () => {
	it("restores emphasis and inline code selected across one paragraph", () => {
		const root = mountMarkdown("<p>Hello <strong>bold move</strong> and <code>x = 1</code> end</p>");
		const range = document.createRange();
		range.selectNodeContents(root.querySelector("p")!);
		expect(rangeToMarkdown(range, document.body)).toBe("Hello **bold move** and `x = 1` end");
	});

	it("keeps a code block's fence and language but not its copy chrome", () => {
		const root = mountMarkdown(`
			<div class="tr-code">
				<div class="tr-code-head"><span class="tr-code-lang">ts</span><button type="button">Copy</button></div>
				<pre><code class="language-ts"><span class="tr-code-line">const a = 1;</span>
<span class="tr-code-line">const b = 2;</span>
</code></pre>
			</div>`);
		const range = document.createRange();
		range.selectNodeContents(root.querySelector("code")!);
		expect(rangeToMarkdown(range, document.body)).toBe("```ts\nconst a = 1;\nconst b = 2;\n```");
	});

	it("rebuilds table rows without the hover toolbar and headerless columns", () => {
		const root = mountMarkdown(`
			<div class="tr-table" data-table-hash="t1">
				<div class="tr-table-bar"><button type="button">Widen</button></div>
				<div class="tr-table-scroll"><table>
					<thead><tr><th>Name</th><th align="right">Count</th></tr></thead>
					<tbody><tr><td>alpha</td><td>2</td></tr></tbody>
				</table></div>
			</div>`);
		const range = document.createRange();
		range.selectNodeContents(root.querySelector("table")!);
		expect(rangeToMarkdown(range, document.body)).toBe("| Name | Count |\n| --- | ---: |\n| alpha | 2 |");
	});

	it("falls back to the plain text outside rendered markdown", () => {
		document.body.innerHTML = `<div class="file-preview">plain editor text</div>`;
		const range = document.createRange();
		range.selectNodeContents(document.querySelector(".file-preview")!);
		expect(rangeToMarkdown(range, document.body)).toBe("plain editor text");
	});
});

describe("SelectionToolbar quote fidelity", () => {
	async function mountToolbar(
		container: HTMLElement,
		onQuote: (text: string, source: SelectionQuoteSource | undefined) => void,
	): Promise<HTMLElement> {
		const rootElement = document.createElement("div");
		rootElement.id = "root";
		document.body.appendChild(rootElement);
		const root = createRoot(rootElement);
		mounted.add(root);
		await act(async () =>
			root.render(
				<SelectionToolbar
					containerRef={{ current: container }}
					onQuote={(text, _pdf, _office, _comment, source) => onQuote(text, source)}
					onAsk={() => {}}
					onCopy={() => {}}
					onNewSession={() => {}}
					onAddNote={() => {}}
				/>,
			),
		);
		return rootElement;
	}

	async function selectAndRelease(text: Text, start: number, end: number): Promise<void> {
		const originalSelection = window.getSelection;
		const range = document.createRange();
		range.setStart(text, start);
		range.setEnd(text, end);
		window.getSelection = (() => ({
			isCollapsed: false,
			toString: () => range.toString(),
			anchorNode: text,
			getRangeAt: () => withLayout(range),
		})) as unknown as typeof window.getSelection;
		try {
			await act(async () => {
				text.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 180, clientY: 200 }));
				await Bun.sleep(30);
			});
		} finally {
			window.getSelection = originalSelection;
		}
	}

	it("quotes a selection longer than 400 characters without truncating it", async () => {
		const long = `start ${"word ".repeat(120)}end`;
		document.body.innerHTML = `<div class="tr-root"><div data-entry-id="src-1"><div class="tr-row tr-row--user"><div class="tr-body"><div class="tr-md"><p>${long}</p></div></div></div></div></div>`;
		const container = document.querySelector<HTMLElement>(".tr-root")!;
		const text = document.querySelector("p")!.firstChild as Text;
		const calls: Array<{ text: string; source: SelectionQuoteSource | undefined }> = [];
		const rootElement = await mountToolbar(container, (value, source) => calls.push({ text: value, source }));
		await selectAndRelease(text, 0, long.length);
		await act(async () => rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-btn")[0]?.click());

		expect(calls).toHaveLength(1);
		expect(calls[0]?.text).toBe(long);
		expect(calls[0]?.text.endsWith("…")).toBe(false);
		expect(calls[0]?.source?.messageId).toBe("src-1");
		expect(calls[0]?.source?.anchor?.text).toBe(long);
		expect(calls[0]?.source?.anchor?.start).toBe(0);
	});

	it("anchors a partial selection to its message so the source fragment can be re-found", async () => {
		document.body.innerHTML = `<div class="tr-root"><div data-entry-id="src-2"><div class="tr-row tr-row--assistant"><div class="tr-body"><div class="tr-md"><p>Hello <strong>world</strong> from the source message.</p></div></div></div></div></div>`;
		const container = document.querySelector<HTMLElement>(".tr-root")!;
		const text = document.querySelector("strong")!.firstChild as Text;
		const calls: Array<{ text: string; source: SelectionQuoteSource | undefined }> = [];
		const rootElement = await mountToolbar(container, (value, source) => calls.push({ text: value, source }));
		await selectAndRelease(text, 0, 5);
		await act(async () => rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-btn")[0]?.click());

		expect(calls[0]?.text).toBe("world");
		expect(calls[0]?.source).toEqual({
			messageId: "src-2",
			anchor: { text: "world", prefix: "Hello ", suffix: " from the source message.", start: 6 },
		});
	});

	it("keeps the pre-anchor behavior for selections outside a message row", async () => {
		document.body.innerHTML = `<div class="tr-root"><div class="tr-md"><p>Detached preview text.</p></div></div>`;
		const container = document.querySelector<HTMLElement>(".tr-root")!;
		const text = document.querySelector("p")!.firstChild as Text;
		const calls: Array<{ text: string; source: SelectionQuoteSource | undefined }> = [];
		const rootElement = await mountToolbar(container, (value, source) => calls.push({ text: value, source }));
		await selectAndRelease(text, 9, 16);
		await act(async () => rootElement.querySelectorAll<HTMLButtonElement>(".gui-select-pop-btn")[0]?.click());

		expect(calls[0]).toEqual({ text: "preview", source: undefined });
	});
});
