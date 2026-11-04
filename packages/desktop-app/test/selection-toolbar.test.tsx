import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SelectionToolbar } from "../src/components/SelectionToolbar";

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
	it("routes one editor selection to all five actions without DOM capture", async () => {
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
		expect(buttons).toHaveLength(5);
		await act(async () => {
			for (const button of buttons) button.click();
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
