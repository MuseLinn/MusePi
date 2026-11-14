import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useStoreSelector } from "../src/lib/use-store";

/**
 * `useStoreSelector` contract: a subscriber that reads two booleans must not
 * re-render when the store publishes an unrelated change.
 *
 * The store rebuilds its snapshot object on every flush, so a plain
 * `useSyncExternalStore` subscriber sees a new reference and re-renders even
 * when nothing it draws from changed. That is what made the header repaint on
 * every streamed token; the selector is the fix, and this pins the fix.
 */

interface ProbeState {
	working: boolean;
	streaming: boolean;
	/** Stands in for the transcript: changes constantly during a turn. */
	transcriptLength: number;
}

function makeProbeStore(initial: ProbeState) {
	let snapshot = initial;
	const listeners = new Set<() => void>();
	return {
		subscribe(cb: () => void): () => void {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		getSnapshot: (): ProbeState => snapshot,
		/** Publish a new snapshot object, exactly like the real store. */
		publish(patch: Partial<ProbeState>): void {
			snapshot = { ...snapshot, ...patch };
			for (const l of listeners) l();
		},
	};
}

/** Counts renders; selects only the two status flags. */
function makeProbe(store: ReturnType<typeof makeProbeStore>) {
	let renders = 0;
	function Probe() {
		renders++;
		const slice = useStoreSelector(store.subscribe, store.getSnapshot, s => ({
			working: s.working,
			streaming: s.streaming,
		}));
		return createElement("span", null, `${slice.working}:${slice.streaming}`);
	}
	return { Probe, renders: () => renders };
}

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);

afterAll(() => {
	act(() => root.unmount());
	host.remove();
});

describe("useStoreSelector", () => {
	test("an unrelated field change does not re-render the subscriber", () => {
		const store = makeProbeStore({ working: false, streaming: false, transcriptLength: 0 });
		const probe = makeProbe(store);
		act(() => root.render(createElement(probe.Probe)));
		const initial = probe.renders();

		// The transcript growing is the hot path: 50 flushes, none of which
		// touch the flags this subscriber reads.
		for (let i = 1; i <= 50; i++) act(() => store.publish({ transcriptLength: i }));

		expect(probe.renders()).toBe(initial);
	});

	test("a change to a selected field does re-render", () => {
		const store = makeProbeStore({ working: false, streaming: false, transcriptLength: 0 });
		const probe = makeProbe(store);
		act(() => root.render(createElement(probe.Probe)));
		const initial = probe.renders();

		act(() => store.publish({ working: true }));
		expect(probe.renders()).toBe(initial + 1);
		expect(host.textContent).toContain("true:false");

		act(() => store.publish({ streaming: true }));
		expect(probe.renders()).toBe(initial + 2);
		expect(host.textContent).toContain("true:true");
	});

	test("equal selections keep their identity so React's check can bail", () => {
		// The comparison is per-field: re-publishing the SAME values in a NEW
		// snapshot object must not count as a change.
		const store = makeProbeStore({ working: true, streaming: false, transcriptLength: 3 });
		const probe = makeProbe(store);
		act(() => root.render(createElement(probe.Probe)));
		const initial = probe.renders();
		act(() => store.publish({ working: true, streaming: false, transcriptLength: 4 }));
		expect(probe.renders()).toBe(initial);
	});
});
