import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UserAttachmentCards } from "../src/components/transcript/user-attachment-cards";
import { t } from "../src/i18n/index.js";
import type { ToolRenderHost } from "../src/tool-render/types";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const hash = "a".repeat(64);
const item = { hash, name: "notes.txt" };

const roots: Root[] = [];

function mount(host: ToolRenderHost): void {
	const element = document.createElement("div");
	document.body.appendChild(element);
	const root = createRoot(element);
	roots.push(root);
	act(() => root.render(<UserAttachmentCards refs={[item]} host={host} />));
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

function button(label: string): HTMLButtonElement {
	const found = Array.from(document.querySelectorAll("button")).find(node => node.textContent === label);
	if (!found) throw new Error(`button ${label} not rendered`);
	return found as HTMLButtonElement;
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

async function openPreview(): Promise<void> {
	act(() => button(t("tools.attachmentPreview")).click());
	await flush();
}

describe("attachment text preview", () => {
	test("opens the first page and renders it as monospace text", async () => {
		const body = "hello attachment";
		const bytes = new TextEncoder().encode(body);
		const host: ToolRenderHost = {
			attachment: {
				read: async (_hash, offset = 0) => ({
					content: Buffer.from(bytes.slice(offset)).toString("base64"),
					size: bytes.length,
					offset,
				}),
			},
		};
		mount(host);

		await openPreview();

		expect(document.querySelector(".tr-attach-preview-text")?.textContent).toBe(body);
	});

	test("pages on demand and stops at the reported size", async () => {
		const offsets: number[] = [];
		const host: ToolRenderHost = {
			attachment: {
				read: async (_hash, offset = 0) => {
					offsets.push(offset);
					const chunk = offset === 0 ? "first" : "second";
					return { content: Buffer.from(chunk).toString("base64"), size: 11, offset };
				},
			},
		};
		mount(host);

		await openPreview();
		expect(document.querySelector(".tr-attach-preview-text")?.textContent).toBe("first");
		act(() => button(t("tools.attachmentLoadMore")).click());
		await flush();

		expect(offsets).toEqual([0, 5]);
		expect(document.querySelector(".tr-attach-preview-text")?.textContent).toBe("firstsecond");
		expect(document.body.textContent).not.toContain(t("tools.attachmentLoadMore"));
	});

	test("reports NUL bytes as binary and offers the host's save action", async () => {
		const saved: string[] = [];
		const host: ToolRenderHost = {
			attachment: {
				read: async () => ({
					content: Buffer.from([0x41, 0x00, 0x42]).toString("base64"),
					size: 3,
					offset: 0,
				}),
				save: (_hash, name) => saved.push(name),
			},
		};
		mount(host);

		await openPreview();

		expect(document.body.textContent).toContain(t("tools.attachmentPreviewUnavailable"));
		act(() => button(t("tools.attachmentSave")).click());
		expect(saved).toEqual(["notes.txt"]);
	});

	test("treats invalid UTF-8 as binary instead of forcing a decode", async () => {
		const host: ToolRenderHost = {
			attachment: {
				read: async () => ({
					content: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
					size: 3,
					offset: 0,
				}),
			},
		};
		mount(host);

		await openPreview();

		expect(document.body.textContent).toContain(t("tools.attachmentPreviewUnavailable"));
		// No save capability → no save entry.
		expect(document.body.textContent).not.toContain(t("tools.attachmentSave"));
	});

	test("copies the reference line the prompt itself uses", async () => {
		const writes: string[] = [];
		const original = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					writes.push(text);
				},
			},
		});
		try {
			mount({});
			act(() => button(t("tools.attachmentCopyRef")).click());
			await flush();
		} finally {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
		}

		expect(writes).toEqual([`[Attachment] blob://${hash} (notes.txt)`]);
	});
});
