import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogFrame } from "../src/components/DialogFrame";

const roots: Root[] = [];

function mount(node: ReactNode): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return root;
}

function pressEscape(): void {
	act(() => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	});
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("DialogFrame", () => {
	test("does not steal focus again when the enter phase advances", async () => {
		mount(
			<DialogFrame open onClose={() => {}} label="Focus dialog">
				<button type="button">First</button>
				<button type="button">Second</button>
			</DialogFrame>,
		);
		const second = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))[1];
		if (!second) throw new Error("second dialog button did not render");
		second.focus();

		await act(async () => Bun.sleep(140));

		expect(document.activeElement === second).toBe(true);
	});

	test("exposes its label as the accessible dialog name", () => {
		mount(
			<DialogFrame open onClose={() => {}} label="Accessible dialog">
				<button type="button">Action</button>
			</DialogFrame>,
		);

		expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Accessible dialog");
	});

	test("only the top nested dialog handles Escape", () => {
		const closed: string[] = [];
		mount(
			<>
				<DialogFrame open onClose={() => closed.push("bottom")} label="Bottom dialog">
					<button type="button">Bottom action</button>
				</DialogFrame>
				<DialogFrame open onClose={() => closed.push("top")} label="Top dialog">
					<button type="button">Top action</button>
				</DialogFrame>
			</>,
		);

		pressEscape();

		expect(closed).toEqual(["top"]);
	});

	test("a handoff inside a one-take drops its own exit animation", () => {
		const root = mount(
			<DialogFrame open onClose={() => {}} label="Detail dialog">
				<button type="button">Detail action</button>
			</DialogFrame>,
		);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();

		// The shared-surface transition (morphSurfaceFrom/morphSurfaceBack) adds
		// this marker before flushing its update; running the 180ms exit as well
		// would leave a fading copy under the incoming surface.
		document.documentElement.classList.add("gui-view-transition");
		try {
			act(() =>
				root.render(
					<DialogFrame open={false} onClose={() => {}} label="Detail dialog">
						<button type="button">Detail action</button>
					</DialogFrame>,
				),
			);
		} finally {
			document.documentElement.classList.remove("gui-view-transition");
		}

		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	test("a dialog that mounts inside a one-take never runs its own entrance", async () => {
		document.documentElement.classList.add("gui-view-transition");
		mount(
			<DialogFrame open onClose={() => {}} label="Mounted in transition">
				<button type="button">Action</button>
			</DialogFrame>,
		);
		const dialog = document.querySelector('[role="dialog"]')!;
		// The first frame is static: no pending→entered phases, so nothing can
		// replay when the marker class leaves at the end of the transition.
		expect(dialog.className).toContain("gui-dialog--static");
		document.documentElement.classList.remove("gui-view-transition");
		await act(async () => Bun.sleep(100));
		expect(dialog.className).toContain("gui-dialog--static");
		expect(dialog.className).not.toContain("gui-dialog--entered");
	});

	test("without a one-take the exit animation still keeps the dialog mounted", () => {
		const root = mount(
			<DialogFrame open onClose={() => {}} label="Ordinary dialog">
				<button type="button">Action</button>
			</DialogFrame>,
		);
		act(() =>
			root.render(
				<DialogFrame open={false} onClose={() => {}} label="Ordinary dialog">
					<button type="button">Action</button>
				</DialogFrame>,
			),
		);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});
});
