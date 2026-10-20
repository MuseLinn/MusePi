/**
 * The composer's send control while the agent works.
 *
 * Three states, and the middle one is the point: while a turn runs AND the
 * draft holds something, the user needs to be able to say "after this one"
 * without knowing the busyEnter setting. The queue button states that intent
 * outright; the stop button stays where it is.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { describe, expect, it } from "bun:test";
import { SendOrStopButton } from "../src/components/composer/action-buttons";
import { act } from "react";
import { createRoot } from "react-dom/client";

function render(props: Partial<Parameters<typeof SendOrStopButton>[0]>): {
	queue: HTMLButtonElement | null;
	stop: HTMLButtonElement | null;
	container: HTMLDivElement;
} {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<SendOrStopButton
				canSend
				busy={false}
				working
				hasContent
				onPress={() => {}}
				onStop={() => {}}
				onQueue={() => {}}
				{...props}
			/>,
		);
	});
	return {
		queue: container.querySelector(".gui-composer-queue"),
		stop: container.querySelector(".gui-composer-send--working"),
		container,
	};
}

describe("send control while working", () => {
	it("offers queueing beside stop when the draft has content", () => {
		const { queue, stop } = render({});
		expect(queue).not.toBeNull();
		expect(stop).not.toBeNull();
	});

	it("hides the queue button when there is nothing to send", () => {
		// A queue button with an empty draft would queue nothing.
		const { queue } = render({ hasContent: false });
		expect(queue).toBeNull();
	});

	it("hides the queue button when the composer is idle", () => {
		// Idle the send button is the plain one; there is nothing to queue for.
		const { queue } = render({ working: false });
		expect(queue).toBeNull();
	});

	it("queues through the explicit callback", () => {
		let queued = 0;
		const { queue } = render({ onQueue: () => queued++ });
		act(() => {
			queue!.click();
		});
		expect(queued).toBe(1);
	});
});
