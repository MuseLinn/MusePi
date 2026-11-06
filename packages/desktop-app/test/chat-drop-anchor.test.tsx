import "./happy-dom-shim";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatDropAnchor } from "../src/components/ChatDropAnchor";

// Chat drop anchor: OS files dragged over the app claim the window (Chromium
// would otherwise navigate to the file), show where the release lands, and
// hand the files to the composer only when the pointer is inside the card.
// Drops the composer already staged must not be staged twice. Surfaces that
// own their own drop (dialogs, dropzones, textareas) keep that ownership.

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
let target: HTMLDivElement;

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

function dragEvent(type: string, x: number, y: number, files: File[] = [], transferTypes?: string[]): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const transfer = {
		types: transferTypes ?? (files.length > 0 ? ["Files"] : ["text/plain"]),
		files,
		dropEffect: "none",
	};
	Object.defineProperty(event, "dataTransfer", { value: transfer });
	Object.defineProperty(event, "clientX", { value: x });
	Object.defineProperty(event, "clientY", { value: y });
	return event;
}

function mount(onFiles: (files: File[]) => void): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<ChatDropAnchor resolveTarget={() => target} onFiles={onFiles} />));
}

const panel = (): Element | null => document.querySelector(".gui-drop-anchor");

beforeAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
});

beforeEach(() => {
	target = document.createElement("div");
	target.getBoundingClientRect = () => rect(100, 100, 600, 400);
	document.body.appendChild(target);
	hosts.push(target);
	vi.spyOn(window, "matchMedia").mockReturnValue({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as MediaQueryList);
});

afterEach(() => {
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
	vi.restoreAllMocks();
});

describe("ChatDropAnchor", () => {
	it("invites the drop inside the card and stages the files", () => {
		const files = [new File(["x"], "a.png", { type: "image/png" })];
		const onFiles = vi.fn();
		mount(onFiles);

		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		expect(panel()).not.toBeNull();

		const drop = dragEvent("drop", 200, 200, files);
		act(() => {
			window.dispatchEvent(drop);
		});
		expect(onFiles).toHaveBeenCalledTimes(1);
		expect(onFiles.mock.calls[0]?.[0]).toEqual(files);
		expect(drop.defaultPrevented).toBe(true);
		expect(panel()).toBeNull();
	});

	it("claims the drag outside the card without staging anything", () => {
		const files = [new File(["x"], "a.txt")];
		const onFiles = vi.fn();
		mount(onFiles);

		const over = dragEvent("dragover", 900, 700, files);
		act(() => {
			window.dispatchEvent(over);
		});
		expect(over.defaultPrevented).toBe(true);
		expect((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe("none");
		expect(panel()).toBeNull();

		act(() => {
			window.dispatchEvent(dragEvent("drop", 900, 700, files));
		});
		expect(onFiles).not.toHaveBeenCalled();
	});

	it("ignores drags that carry no files", () => {
		const onFiles = vi.fn();
		mount(onFiles);
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, [], ["text/plain"]));
		});
		expect(panel()).toBeNull();
		act(() => {
			window.dispatchEvent(dragEvent("drop", 200, 200, [], ["text/plain"]));
		});
		expect(onFiles).not.toHaveBeenCalled();
	});

	it("does not stage a drop the composer already handled", () => {
		const files = [new File(["x"], "a.png", { type: "image/png" })];
		const onFiles = vi.fn();
		mount(onFiles);

		const inner = document.createElement("div");
		target.appendChild(inner);
		inner.addEventListener("drop", event => event.preventDefault());

		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		const drop = dragEvent("drop", 200, 200, files);
		Object.defineProperty(drop, "target", { value: inner });
		act(() => {
			inner.dispatchEvent(drop);
		});
		expect(onFiles).not.toHaveBeenCalled();
		expect(panel()).toBeNull();
	});

	it("hides the invitation when the drag leaves or Escape is pressed", () => {
		const files = [new File(["x"], "a.txt")];
		mount(vi.fn());
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		expect(panel()).not.toBeNull();
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 900, 700, files));
		});
		expect(panel()).toBeNull();

		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		expect(panel()).not.toBeNull();
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(panel()).toBeNull();
	});

	it("keeps a claimed dragover's dropEffect", () => {
		const files = [new File(["x"], "a.png", { type: "image/png" })];
		mount(vi.fn());
		// A composer textarea / plugin dropzone prevents dragover itself.
		const inner = document.createElement("div");
		target.appendChild(inner);
		inner.addEventListener("dragover", event => event.preventDefault());

		const over = dragEvent("dragover", 200, 200, files);
		const transfer = (over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer;
		transfer.dropEffect = "move";
		act(() => {
			inner.dispatchEvent(over);
		});
		expect(over.defaultPrevented).toBe(true);
		expect(transfer.dropEffect).toBe("move");
		// The textarea is inside the card, so the invitation still shows.
		expect(panel()).not.toBeNull();
	});

	it("yields a modal surface without staging or navigating", () => {
		const files = [new File(["x"], "plugin.zip")];
		const onFiles = vi.fn();
		mount(onFiles);
		const backdrop = document.createElement("div");
		backdrop.className = "gui-dialog-backdrop";
		const dialog = document.createElement("div");
		dialog.className = "gui-dialog";
		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
		hosts.push(backdrop);

		const over = dragEvent("dragover", 200, 200, files);
		act(() => {
			dialog.dispatchEvent(over);
		});
		expect(panel()).toBeNull();
		expect(over.defaultPrevented).toBe(true);

		const drop = dragEvent("drop", 200, 200, files);
		act(() => {
			dialog.dispatchEvent(drop);
		});
		expect(drop.defaultPrevented).toBe(true);
		expect(onFiles).not.toHaveBeenCalled();
	});

	it("re-measures the card when it moves mid-drag", () => {
		const files = [new File(["x"], "a.txt")];
		mount(vi.fn());
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		expect((panel() as HTMLElement).style.left).toBe("100px");

		// The right-panel spring or a scene cross-fade moves the card while the
		// OS drag still owns the pointer.
		target.getBoundingClientRect = () => rect(140, 120, 600, 400);
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		expect((panel() as HTMLElement).style.left).toBe("140px");

		// The hit test uses the same new rect: 110,200 is inside the OLD card
		// but outside the moved one.
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 110, 200, files));
		});
		expect(panel()).toBeNull();
	});

	it("claims Escape only while the invitation is up", () => {
		const files = [new File(["x"], "a.txt")];
		mount(vi.fn());
		const idle = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		act(() => {
			window.dispatchEvent(idle);
		});
		expect(idle.defaultPrevented).toBe(false);

		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		const active = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		act(() => {
			window.dispatchEvent(active);
		});
		expect(active.defaultPrevented).toBe(true);
		expect(panel()).toBeNull();
	});

	it("withdraws the invitation on dragend", () => {
		const files = [new File(["x"], "a.txt")];
		mount(vi.fn());
		act(() => {
			window.dispatchEvent(dragEvent("dragover", 200, 200, files));
		});
		expect(panel()).not.toBeNull();
		act(() => {
			window.dispatchEvent(new Event("dragend", { bubbles: true }));
		});
		expect(panel()).toBeNull();
	});
});
