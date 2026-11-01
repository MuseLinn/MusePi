import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../src/components/shell/Composer";
import { GuestClient } from "../src/lib/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
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
		const textarea = document.querySelector<HTMLTextAreaElement>(".sh-composer-input");
		const button = document.querySelector<HTMLButtonElement>('[data-morph-id="composer-send"]');
		if (!textarea || !button) throw new Error("composer controls did not render");
		const draft = textarea.value;
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
		expect(textarea.value).toBe(draft);
		expect(button.disabled).toBe(false);

		send.mockResolvedValue();
		await act(async () => {
			button.click();
			await Promise.resolve();
		});
		expect(textarea.value).toBe("");
	});

	it("limits a workspace draft to three suggestions without an expansion action", async () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "workspace", sessions: [] });
		await renderComposer(client);

		expect(document.querySelectorAll(".sh-suggest-chip")).toHaveLength(3);
		expect(document.querySelector(".sh-suggest-chip--more")).toBeNull();
		const textarea = document.querySelector<HTMLTextAreaElement>(".sh-composer-input");
		expect(textarea?.disabled).toBe(false);
		expect(textarea?.placeholder).not.toBe("Waiting for session…");
	});

	it("expands a compact composer on focus and keeps it open behind the attachment sheet", async () => {
		mockViewport(390);
		await renderComposer(liveClient());
		const inner = document.querySelector<HTMLElement>(".sh-composer-inner");
		const textarea = document.querySelector<HTMLTextAreaElement>(".sh-composer-input");
		expect(inner?.dataset.expanded).toBe("false");
		expect(textarea).not.toBeNull();

		await act(async () => textarea?.focus());
		expect(inner?.dataset.expanded).toBe("true");
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Add images"]')?.click());
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(inner?.dataset.expanded).toBe("true");
		expect(document.querySelector<HTMLTextAreaElement>(".sh-composer-input")).toBe(textarea);
	});

	it("switches the compact end action between voice and send without moving the input", async () => {
		mockViewport(390);
		await renderComposer(liveClient());
		expect(document.querySelector(".sh-composer-mic")).not.toBeNull();
		expect(document.querySelector(".sh-composer-send")).toBeNull();
		const textarea = document.querySelector<HTMLTextAreaElement>(".sh-composer-input");

		await act(async () => document.querySelector<HTMLButtonElement>(".sh-suggest-chip")?.click());
		expect(document.querySelector<HTMLTextAreaElement>(".sh-composer-input")).toBe(textarea);
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
		const textarea = document.querySelector<HTMLTextAreaElement>(".sh-composer-input");
		await act(async () => textarea?.focus());
		const controls = document.querySelectorAll<HTMLButtonElement>(".sh-mt-seg");
		const modelButton = controls[0];
		expect(modelButton).not.toBeNull();
		expect(controls[1]?.textContent).toBe("Medium");

		await act(async () => {
			const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
			modelButton?.dispatchEvent(pointerDown);
			if (!pointerDown.defaultPrevented) textarea?.blur();
			modelButton?.click();
		});
		expect(document.activeElement).toBe(textarea);
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
