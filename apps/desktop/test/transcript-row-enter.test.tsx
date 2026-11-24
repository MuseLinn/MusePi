import "./happy-dom-shim";
import { afterEach, expect, it } from "bun:test";
import { Transcript } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-24T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as unknown as SessionEntry;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
});

function mount(entries: readonly SessionEntry[]): HTMLElement {
	if (host === null) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	const element = (
		<Transcript
			entries={entries}
			stream={null}
			streamDone
			activeTools={new Map()}
			working={false}
			sessionKey="session-under-test"
		/>
	);
	act(() => root?.render(element));
	return host;
}

it("marks only the user row that appears after the first paint", () => {
	const first = mount([userEntry("user-1", "first")]);
	expect(first.querySelectorAll('[data-enter="true"]').length).toBe(0);

	const second = mount([userEntry("user-1", "first"), userEntry("user-2", "second")]);
	const entering = second.querySelectorAll('[data-enter="true"]');
	expect(entering.length).toBe(1);
	expect(entering[0]?.getAttribute("data-entry-key")).toBe("user-2");
});

it("does not replay the entrance for a row that was already known", () => {
	mount([userEntry("user-1", "first"), userEntry("user-2", "second")]);
	const hostEl = mount([userEntry("user-1", "first"), userEntry("user-2", "second")]);
	expect(hostEl.querySelectorAll('[data-enter="true"]').length).toBe(0);
});

it("re-primes on a session switch instead of animating the history", () => {
	const hostEl = mount([userEntry("user-1", "first")]);
	act(() =>
		root?.render(
			<Transcript
				entries={[userEntry("user-1", "first"), userEntry("user-2", "second")]}
				stream={null}
				streamDone
				activeTools={new Map()}
				working={false}
				sessionKey="another-session"
			/>,
		),
	);
	expect(hostEl.querySelectorAll('[data-enter="true"]').length).toBe(0);
});
