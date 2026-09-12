import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStreamingReveal } from "../src/components/transcript/use-streaming-reveal";

// The assertions below depend on EFFECT-driven renders (the reveal advances in
// an effect), which bun:test's default environment cannot do — register
// happy-dom globally for this file, as the other effect-driven suites do.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

beforeEach(() => {
	// Hold the frame clock. The reveal advances inside rAF callbacks, and an
	// awaited act() runs those to completion — a message that starts revealing
	// would be fully shown again by the time an assertion could run, hiding the
	// very state under test. With frames frozen, what the component displays is
	// what it decided to display, not how far the reveal has since caught up.
	vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1 as unknown as number);
	vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Probe the hook's output; the hook is the unit under test. */
function Probe({
	text,
	streaming,
	enabled = true,
}: {
	text: string;
	streaming: boolean;
	enabled?: boolean;
}): ReactNode {
	return createElement("span", { "data-testid": "out" }, useStreamingReveal(text, streaming, enabled));
}

const HISTORY = Array.from({ length: 40 }, (_, i) => `line ${i} of already finished output`).join(" ");

interface Mounted {
	container: HTMLElement;
	root: Root;
}

async function mount(element: ReactNode): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	// Act flushes effects AND the state updates those effects schedule, so
	// assertions observe the settled render rather than the first paint.
	await act(async () => {
		root.render(element);
	});
	return { container, root };
}

describe("useStreamingReveal mount semantics", () => {
	it("shows a settled message in full once effects have run", async () => {
		// Mounting a finished message (history, session switch) must NOT animate:
		// reading "revealed 0 < total" as a backlog made the settle drain treat the
		// whole committed message as pending, so it typed out from empty on mount.
		const { container, root } = await mount(createElement(Probe, { text: HISTORY, streaming: false }));

		expect(container.textContent).toBe(HISTORY);
		await act(async () => root.unmount());
	});

	it("shows a message mounted mid-stream in full, then animates only new text", async () => {
		// Switching into a live session re-mounts the streaming block; its text
		// was already on screen before the switch, so it appears at once and only
		// the growth afterwards animates.
		const { container, root } = await mount(createElement(Probe, { text: HISTORY, streaming: true }));
		expect(container.textContent).toBe(HISTORY);

		const grown = `${HISTORY} and this part arrives after the mount`;
		await act(async () => {
			root.render(createElement(Probe, { text: grown, streaming: true }));
		});

		const shown = container.textContent ?? "";
		// Frames are frozen, so the newly arrived text cannot be visible yet —
		// while everything already shown must still be there.
		expect(shown.startsWith(HISTORY)).toBe(true);
		expect(shown.length).toBeLessThan(grown.length);
		await act(async () => root.unmount());
	});

	it("with the reveal disabled, a settled message is never partial", async () => {
		const { container, root } = await mount(
			createElement(Probe, { text: HISTORY, streaming: false, enabled: false }),
		);

		expect(container.textContent).toBe(HISTORY);
		await act(async () => root.unmount());
	});
});
