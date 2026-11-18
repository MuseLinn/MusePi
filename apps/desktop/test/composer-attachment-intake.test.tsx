import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAttachments } from "../src/components/composer/use-attachments";
import type { RpcClient } from "../src/lib/rpc";

const roots: Root[] = [];
afterEach(async () => {
	while (roots.length) {
		const root = roots.pop();
		await act(async () => root?.unmount());
	}
	document.body.innerHTML = "";
});

type Api = ReturnType<typeof useAttachments> | null;

const rpc = {
	request: async (method: string) => (method === "settings.get" ? {} : null),
	addEventListener: () => () => {},
} as unknown as RpcClient;

function Probe({ api, stageFiles }: { api: { current: Api }; stageFiles: boolean }): null {
	const controller = useAttachments(rpc, { stageFiles });
	api.current = controller;
	return null;
}

function mount(stageFiles: boolean): { current: Api } {
	const api: { current: Api } = { current: null };
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<Probe api={api} stageFiles={stageFiles} />));
	return api;
}

const NOTES = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });
const IMAGE = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

describe("useAttachments intake modes", () => {
	it("draft mode keeps raw file handles and starts no upload", async () => {
		const api = mount(false);
		await act(async () => {
			await api.current!.addFiles([IMAGE, NOTES]);
		});
		const chips = api.current!.attachments;
		expect(chips.map(c => c.kind)).toEqual(["image", "file"]);
		expect(chips[0]!.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		expect(chips[1]!.file).toBe(NOTES);
		expect(chips[1]!.staged).toBeUndefined();
	});

	it("session mode stages the file upload with the chip", async () => {
		const api = mount(true);
		await act(async () => {
			await api.current!.addFiles([NOTES]);
		});
		expect(api.current!.attachments[0]!.staged).toBeDefined();
	});
});
