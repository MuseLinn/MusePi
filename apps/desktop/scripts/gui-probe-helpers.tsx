/**
 * Scenario helpers for `gui-probe.ts`.
 *
 * A scenario answers three things: what to render, what to measure, and — when
 * it has one — what the measurement must say. Only the middle one needs any
 * thought, so it is a small vocabulary here instead of bespoke code per
 * scenario.
 *
 * The measurements are deliberately *layout* facts (boxes, computed properties,
 * text, interaction states) rather than pixels. A pixel diff tells a reviewer
 * that something moved; `height: 271.625px` beside `flex: 1 1 0%` tells them
 * why, which is the difference between a screenshot and evidence.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * What a scenario must provide.
 *
 * Typed here rather than in the runner because the runner never imports the
 * scenario (see `scenarioNames` in `gui-probe.ts`): the type is the only thing
 * the author's side and the page's side share, so it has to live beside the
 * helpers the author actually uses.
 */
export interface GuiScenario {
	/** Crop the screenshot to this selector; the whole page when omitted. */
	capture?: string;
	render(root: HTMLElement): Promise<void>;
	measure?(body: ParentNode): Promise<Record<string, unknown>> | Record<string, unknown>;
	/** `elements` keys, each with exact values or `{min|max}` bounds. */
	expect?: Record<string, Record<string, unknown>>;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Render into a container and let effects settle. Dialogs portal to `body`. */
export async function mount(element: React.ReactNode, container: HTMLElement): Promise<void> {
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
	});
	await act(async () => sleep(40));
}

/** Click by visible text inside a container, then settle. */
export async function clickText(container: ParentNode, selector: string, label: string): Promise<boolean> {
	const node = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(item =>
		(item.textContent ?? "").trim().includes(label),
	);
	if (!node) return false;
	await act(async () => {
		node.click();
		await sleep(40);
	});
	return true;
}

/** Set an input's value the way a user's typing does (React-compatible). */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await sleep(20);
	});
}

export interface Box {
	w: number;
	h: number;
	top: number;
	left: number;
}

export interface ElementReading {
	text: string;
	box: Box;
	/** Properties that explain a box, not just record it. */
	display?: string;
	flex?: string;
	borderRadius?: string;
	color?: string;
	background?: string;
	outline?: string;
	opacity?: string;
	disabled?: boolean;
	cursor?: string;
	checked?: string | null;
}

const round = (value: number): number => Math.round(value);

export function readBox(node: Element | null): Box | null {
	if (!node) return null;
	const box = node.getBoundingClientRect();
	return { w: round(box.width), h: round(box.height), top: round(box.top), left: round(box.left) };
}

export function readElement(node: Element | null, computed: boolean = true): ElementReading | null {
	if (!node) return null;
	const box = readBox(node);
	if (!box) return null;
	const reading: ElementReading = { text: (node.textContent ?? "").trim().slice(0, 200), box };
	if (computed) {
		const style = getComputedStyle(node);
		reading.display = style.display;
		reading.flex = style.flex;
		reading.borderRadius = style.borderRadius;
		reading.color = style.color;
		reading.background = style.backgroundColor;
		reading.outline = style.outlineStyle;
		reading.opacity = style.opacity;
		reading.cursor = style.cursor;
		const html = node as HTMLElement;
		reading.disabled = html.hasAttribute("disabled");
		reading.checked = html.getAttribute("aria-checked");
	}
	return reading;
}

/**
 * Measure every element a scenario names, keyed by selector.
 *
 * A selector that matches nothing reads as `null` rather than disappearing, so
 * "the toolbar is gone" is a value a scenario can assert on instead of a lookup
 * that quietly returns `undefined` and passes.
 */
export function measure(root: ParentNode, selectors: Record<string, string>): Record<string, ElementReading | null> {
	const out: Record<string, ElementReading | null> = {};
	for (const [key, selector] of Object.entries(selectors)) {
		out[key] = readElement(root.querySelector(selector));
	}
	return out;
}

/** How many nodes each selector matches — for "no duplicates" assertions. */
export function countAll(root: ParentNode, selector: string): number {
	return root.querySelectorAll(selector).length;
}

/**
 * Focus an element and report its focus ring.
 *
 * `:focus-visible` is what a keyboard user sees, and it cannot be triggered by
 * `.focus()` alone in every engine — this checks the ring a real tab key would
 * draw, which is the contract in `docs/gui-design.md`.
 */
export async function focusAndRead(node: HTMLElement | null): Promise<ElementReading | null> {
	if (!node) return null;
	await act(async () => {
		node.focus();
		await sleep(60);
	});
	return readElement(node);
}
