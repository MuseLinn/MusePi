import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePdfLoadTimeout } from "../src/components/FilePdfPreview";

function TimeoutHarness(): React.ReactNode {
	const loadTimedOut = usePdfLoadTimeout(5);
	return <span>{loadTimedOut ? "timed-out" : "pending"}</span>;
}

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("PDF load timeout", () => {
	it("expires while loading and resets when a retry remounts the reader", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () => root.render(<TimeoutHarness key="first" />));
		expect(container.textContent).toBe("pending");

		await act(async () => {
			await Bun.sleep(20);
		});
		expect(container.textContent).toBe("timed-out");

		await act(async () => root.render(<TimeoutHarness key="retry" />));
		expect(container.textContent).toBe("pending");
	});
});
