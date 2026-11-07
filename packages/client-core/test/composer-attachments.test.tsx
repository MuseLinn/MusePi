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

/** Fill the draft from a suggestion chip (the text is not the assertion target). */
async function draftText(): Promise<string> {
	await act(async () => document.querySelector<HTMLButtonElement>(".sh-suggest-chip")?.click());
	return document.querySelector<HTMLTextAreaElement>(".sh-composer-input")?.value ?? "";
}

/** Drive the hidden any-file picker the way a real selection does. */
async function pickFiles(files: File[]): Promise<void> {
	const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([accept])');
	if (!input) throw new Error("file picker did not render");
	Object.defineProperty(input, "files", { value: files, configurable: true });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

const NOTES = new File([new Uint8Array([0, 1, 2])], "notes.txt", { type: "text/plain" });

describe("Composer file attachments", () => {
	it("disables send while the upload is in flight, then sends the reference line first", async () => {
		const client = liveClient();
		const upload = Promise.withResolvers<unknown>();
		vi.spyOn(client, "rpc").mockReturnValue(upload.promise as Promise<never>);
		const send = vi.spyOn(client, "sendPrompt").mockResolvedValue();
		await renderComposer(client);
		const draft = await draftText();

		await pickFiles([NOTES]);

		const chip = document.querySelector<HTMLElement>(".sh-attach-file");
		expect(chip?.dataset.status).toBe("uploading");
		expect(chip?.textContent).toContain("Uploading…");
		const button = document.querySelector<HTMLButtonElement>(".sh-composer-send");
		expect(button?.disabled).toBe(true);
		expect(button?.title).toBe("Wait for attachments to finish uploading");

		await act(async () => {
			upload.resolve({ url: "blob://abc123" });
			await Promise.resolve();
		});
		expect(chip?.dataset.status).toBe("ready");
		expect(button?.disabled).toBe(false);

		await act(async () => {
			button?.click();
			await Promise.resolve();
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toBe(`[Attachment] blob://abc123 (notes.txt)\n\n${draft}`);
		expect(document.querySelector(".sh-attach-file")).toBeNull();
	});

	it("keeps a failed chip visible and refuses to send a prompt without its attachment", async () => {
		const client = liveClient();
		vi.spyOn(client, "rpc").mockRejectedValue(new Error("network down"));
		const send = vi.spyOn(client, "sendPrompt").mockResolvedValue();
		await renderComposer(client);
		const draft = await draftText();

		await pickFiles([NOTES]);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const chip = document.querySelector<HTMLElement>(".sh-attach-file");
		expect(chip?.dataset.status).toBe("error");
		expect(chip?.textContent).toContain("Upload failed");
		expect(chip?.title).toContain("network down");

		await act(async () => {
			document.querySelector<HTMLButtonElement>(".sh-composer-send")?.click();
			await Promise.resolve();
		});
		expect(send).not.toHaveBeenCalled();
		expect(document.querySelector(".sh-composer-error")?.textContent).toBe("notes.txt failed to upload");
		expect(document.querySelector<HTMLTextAreaElement>(".sh-composer-input")?.value).toBe(draft);
		expect(document.querySelector(".sh-attach-file")).not.toBeNull();
	});

	it("uploads a multi-file pick one file at a time", async () => {
		const client = liveClient();
		const first = Promise.withResolvers<unknown>();
		const second = Promise.withResolvers<unknown>();
		const rpc = vi
			.spyOn(client, "rpc")
			.mockReturnValueOnce(first.promise as Promise<never>)
			.mockReturnValueOnce(second.promise as Promise<never>);
		await renderComposer(client);

		await pickFiles([NOTES, new File([new Uint8Array([3])], "b.txt", { type: "text/plain" })]);

		// The daemon evicts the oldest of more than four open chunked uploads, so
		// the second file must not start before the first one settles.
		expect(rpc).toHaveBeenCalledTimes(1);
		await act(async () => {
			first.resolve({ url: "blob://one" });
			await Promise.resolve();
		});
		expect(rpc).toHaveBeenCalledTimes(2);
		await act(async () => {
			second.resolve({ url: "blob://two" });
			await Promise.resolve();
		});
		expect([...document.querySelectorAll<HTMLElement>(".sh-attach-file")].map(chip => chip.dataset.status)).toEqual([
			"ready",
			"ready",
		]);
	});
});
