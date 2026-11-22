import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHostCatalog } from "../src/lib/connection/use-host-catalog";

/**
 * `useHostCatalog().refresh` must keep its identity across renders.
 *
 * The defect this pins: `refresh` was rebuilt on every render, so the shape the
 * hook's own doc comment invites —
 *
 *     const { catalog, refresh } = useHostCatalog();
 *     useEffect(() => { if (open) refresh(); }, [open, refresh]);
 *
 * — loops forever. `refresh()` bumps the nonce, the nonce re-reads the catalog,
 * the catalog re-renders, the render mints a new `refresh`, the effect's deps
 * changed, so it fires again. Observed as a test that never terminates with
 * "Maximum update depth exceeded" as its only output, which is a hard failure
 * to diagnose from the symptom.
 *
 * Two assertions, because either alone can pass on a broken hook:
 *
 *  1. **Identity is stable across renders.** A probe re-renders itself and
 *     collects the function each render saw; every one must be the same
 *     reference.
 *  2. **The invited effect shape settles.** A probe writes the dependency array
 *     from the doc comment verbatim and counts effect runs; with a per-render
 *     identity that count climbs on every render instead of stopping.
 */

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	delete (globalThis as { musepiShell?: unknown }).musepiShell;
});

/** No bridge is installed, so the hook's read resolves to an empty catalog.
 *  That is enough to render; the identity contract does not depend on data. */
function mount(Probe: () => null): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	act(() => root.render(<Probe />));
}

describe("useHostCatalog refresh identity", () => {
	test("the same function survives re-renders", () => {
		const seen: Array<() => void> = [];
		const control = { rerender: () => {} };

		function Probe(): null {
			const { refresh } = useHostCatalog();
			seen.push(refresh);
			const [, setTick] = useState(0);
			control.rerender = () => setTick(value => value + 1);
			return null;
		}

		mount(Probe);
		expect(seen.length).toBeGreaterThan(0);
		const first = seen[0];

		act(() => control.rerender());
		act(() => control.rerender());

		expect(seen.length).toBeGreaterThanOrEqual(3);
		for (const identity of seen) expect(identity).toBe(first as () => void);
	});

	test("the effect shape the doc comment invites settles instead of looping", () => {
		const state = { runs: 0, setOpen: (_: boolean) => {} };

		function Probe(): null {
			const { refresh } = useHostCatalog();
			const [open, setOpen] = useState(false);
			state.setOpen = setOpen;
			useEffect(() => {
				if (!open) return;
				state.runs += 1;
				refresh();
			}, [open, refresh]);
			return null;
		}

		mount(Probe);
		expect(state.runs).toBe(0);

		// Opening must run the effect and then stop. With a per-render `refresh`
		// this count keeps climbing, because the nonce re-render mints a new
		// callback and re-arms the effect.
		act(() => state.setOpen(true));
		const afterOpen = state.runs;
		expect(afterOpen).toBeGreaterThanOrEqual(1);

		// Let anything in flight settle, then assert it stopped.
		act(() => {});
		act(() => {});
		expect(state.runs).toBe(afterOpen);
	});
});
