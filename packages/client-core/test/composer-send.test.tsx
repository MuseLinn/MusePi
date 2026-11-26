import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { EditorView } from "@codemirror/view";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { COLLAB_PROTO, encodeBase64Url, formatCollabLink } from "@musepi/collab-proto";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../src/components/shell/Composer";
import { GuestClient } from "../src/lib/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = formatCollabLink("wss://relay.example.com", "roomroomroom1234", new Uint8Array(32));
const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] };
const roots: Root[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await act(async () => root.unmount());
	}
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

function composerHost(): HTMLElement {
	const host = document.querySelector<HTMLElement>(".sh-composer-editor");
	if (!host) throw new Error("composer editor did not render");
	return host;
}

function composerView(): EditorView {
	const content = composerHost().querySelector<HTMLElement>(".cm-content");
	const view = content ? EditorView.findFromDOM(content) : null;
	if (!view) throw new Error("CodeMirror view not mounted");
	return view;
}

function composerDoc(): string {
	return composerView().state.doc.toString();
}

function composerCaret(): number {
	return composerView().state.selection.main.head;
}

function focusComposer(): void {
	composerView().focus();
}

function liveClient(): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: [] as AgentSnapshot[],
		entryCount: 0,
	});
	return client;
}

async function renderComposer(client: GuestClient): Promise<void> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<Composer client={client} />));
}

function mockViewport(width: number, height = 800): void {
	vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
		const compact = width < 600 || (height < 480 && width < 1024);
		const medium = width < 840;
		return {
			matches: query.includes("599px") ? compact : query.includes("839px") ? medium : false,
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		} as unknown as MediaQueryList;
	});
}

describe("Composer draft sending", () => {
	it("prevents duplicate submission and preserves the draft after a failed send", async () => {
		const client = liveClient();
		const pending = Promise.withResolvers<void>();
		const send = vi.spyOn(client, "sendPrompt").mockReturnValue(pending.promise);
		await renderComposer(client);

		const suggestion = document.querySelector<HTMLButtonElement>(".sh-suggest-chip");
		expect(suggestion).not.toBeNull();
		await act(async () => suggestion?.click());
		const textarea = composerHost();
		const button = document.querySelector<HTMLButtonElement>('[data-morph-id="composer-send"]');
		if (!textarea || !button) throw new Error("composer controls did not render");
		const draft = composerDoc();
		expect(draft.length).toBeGreaterThan(0);

		await act(async () => {
			button.click();
			button.click();
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(button.disabled).toBe(true);

		pending.reject(new Error("create denied"));
		await act(async () => await Promise.resolve());
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("create denied");
		expect(composerDoc()).toBe(draft);
		expect(button.disabled).toBe(false);

		send.mockResolvedValue();
		await act(async () => {
			button.click();
			await Promise.resolve();
		});
		expect(composerDoc()).toBe("");
	});

	it("limits a workspace draft to three suggestions without an expansion action", async () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "workspace", sessions: [] });
		await renderComposer(client);

		expect(document.querySelectorAll(".sh-suggest-chip")).toHaveLength(3);
		expect(document.querySelector(".sh-suggest-chip--more")).toBeNull();
		const textarea = composerHost();
		expect(composerHost().dataset.editable === "1").toBe(false);
		expect(document.querySelector(".musepi-composer-editor__placeholder")?.textContent).not.toBe(
			"Waiting for session…",
		);
	});

	it("expands a compact composer on focus and keeps it open behind the attachment sheet", async () => {
		mockViewport(390);
		await renderComposer(liveClient());
		const inner = document.querySelector<HTMLElement>(".sh-composer-inner");
		const textarea = composerHost();
		expect(inner?.dataset.expanded).toBe("false");
		expect(textarea).not.toBeNull();

		await act(async () => focusComposer());
		expect(inner?.dataset.expanded).toBe("true");
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Attachments"]')?.click());
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(inner?.dataset.expanded).toBe("true");
		expect(composerHost()).toBe(textarea);
	});

	it("switches the compact end action between voice and send without moving the input", async () => {
		mockViewport(390);
		await renderComposer(liveClient());
		expect(document.querySelector(".sh-composer-mic")).not.toBeNull();
		expect(document.querySelector(".sh-composer-send")).toBeNull();
		const textarea = composerHost();

		await act(async () => document.querySelector<HTMLButtonElement>(".sh-suggest-chip")?.click());
		expect(composerHost()).toBe(textarea);
		expect(document.querySelector(".sh-composer-mic")).toBeNull();
		expect(document.querySelector(".sh-composer-send")).not.toBeNull();
	});

	it("keeps the compact model control mounted through pointer-down and opens its sheet", async () => {
		mockViewport(390);
		const client = liveClient();
		client.applyFrameForTest({
			t: "state",
			state: {
				...STATE,
				model: { id: "model-1", name: "Model One", provider: "test", contextWindow: null },
				thinkingLevel: "medium",
			},
		});
		await renderComposer(client);
		const textarea = composerHost();
		await act(async () => focusComposer());
		const controls = document.querySelectorAll<HTMLButtonElement>(".sh-mt-seg");
		const modelButton = controls[0];
		expect(modelButton).not.toBeNull();
		expect(controls[1]?.textContent).toBe("Medium");

		await act(async () => {
			const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
			modelButton?.dispatchEvent(pointerDown);
			if (!pointerDown.defaultPrevented) composerView().contentDOM.blur();
			modelButton?.click();
		});
		expect(document.activeElement).toBe(composerView().contentDOM);
		expect(document.querySelector(".sh-composer-inner")?.getAttribute("data-expanded")).toBe("true");
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it("uses real file inputs for camera and library attachments", async () => {
		await renderComposer(liveClient());
		const pickers = [...document.querySelectorAll<HTMLInputElement>('input[accept="image/*"]')];
		expect(pickers).toHaveLength(2);
		expect(pickers.every(input => input.type === "file")).toBe(true);
	});
});

describe("Composer revert restore", () => {
	it("puts the reverted prompt back into the textarea with the caret at its end", async () => {
		await renderComposer(liveClient());
		const textarea = composerHost();
		if (!textarea) throw new Error("composer textarea did not render");

		await act(async () => {
			window.dispatchEvent(new CustomEvent("musepi-gui-restore-prompt", { detail: { text: "原来的问题" } }));
		});

		expect(composerDoc()).toBe("原来的问题");
		expect(composerCaret()).toBe("原来的问题".length);
	});
});
