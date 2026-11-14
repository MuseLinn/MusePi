import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { attachmentVideoSelection } from "../src/components/composer/use-attachments";

type Bridge = { getDroppedFilePath?: (file: File) => string };

function videoChip(id: number, name = "clip.mp4") {
	const file = new File([new Uint8Array(4)], name, { type: "video/mp4" });
	return {
		id,
		kind: "file" as const,
		dataUrl: "",
		mimeType: "video/mp4",
		name,
		size: 4,
		file,
	};
}

afterEach(() => {
	delete (window as unknown as { electronAPI?: Bridge }).electronAPI;
});

describe("attachmentVideoSelection", () => {
	it("turns a path-backed video chip into a video part", () => {
		(window as unknown as { electronAPI?: Bridge }).electronAPI = {
			getDroppedFilePath: () => "D:\\media\\clip.mp4",
		};
		const chip = videoChip(1);
		const selection = attachmentVideoSelection([chip]);
		expect(selection.chipIds.has(1)).toBe(true);
		expect(selection.parts).toEqual([{ type: "video", mimeType: "video/mp4", url: "file://D:\\media\\clip.mp4" }]);
	});

	it("leaves a video chip on the workspace channel when no path is available", () => {
		// No bridge: a pasted clip has no filesystem path — never drop its bytes.
		const chip = videoChip(2);
		const selection = attachmentVideoSelection([chip]);
		expect(selection.chipIds.size).toBe(0);
		expect(selection.parts).toEqual([]);
	});

	it("ignores image and plain-file chips", () => {
		(window as unknown as { electronAPI?: Bridge }).electronAPI = { getDroppedFilePath: () => "/tmp/x" };
		const image = {
			id: 3,
			kind: "image" as const,
			dataUrl: "data:image/png;base64,AAAA",
			mimeType: "image/png",
			name: "a.png",
			size: 3,
		};
		const doc = {
			id: 4,
			kind: "file" as const,
			dataUrl: "",
			mimeType: "application/pdf",
			name: "a.pdf",
			size: 3,
			file: new File([new Uint8Array(3)], "a.pdf", { type: "application/pdf" }),
		};
		const selection = attachmentVideoSelection([image, doc]);
		expect(selection.chipIds.size).toBe(0);
		expect(selection.parts).toEqual([]);
	});
});
