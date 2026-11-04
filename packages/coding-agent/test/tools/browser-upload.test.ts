import { describe, expect, it } from "bun:test";
import {
	acceptFromAttributes,
	completeAgentUpload,
	completeInterceptedUpload,
	normalizeAcceptList,
	summarizeAccept,
	toActionableHandle,
	type UploadBridgeRequest,
	uploadBridgeEndpoint,
	uploadCanceledError,
	uploadFilesOnHandle,
	uploadTargetLabel,
} from "@musepi/pi-coding-agent/tools/browser/tab-worker";

const SITE = { host: "files.example.com", url: "https://files.example.com/upload", title: "Upload" };

function request(overrides: Partial<UploadBridgeRequest> = {}): UploadBridgeRequest {
	return { mode: "site", site: SITE, accept: ["image/png"], multiple: false, ...overrides };
}

describe("browser upload — accept handling", () => {
	it("normalizes the accept attribute into unique, lowercased entries", () => {
		expect(normalizeAcceptList(" image/png, .PDF ,image/png,, ")).toEqual(["image/png", ".pdf"]);
		expect(normalizeAcceptList(undefined)).toEqual([]);
	});

	it("reads accept from a flat CDP attribute list", () => {
		expect(acceptFromAttributes(["type", "file", "accept", ".png,image/jpeg"])).toEqual([".png", "image/jpeg"]);
		expect(acceptFromAttributes(["type", "file"])).toEqual([]);
		expect(acceptFromAttributes(undefined)).toEqual([]);
	});

	it("summarizes an empty accept list as a wildcard", () => {
		expect(summarizeAccept([])).toBe("*/*");
		expect(summarizeAccept(["image/png"])).toBe("image/png");
	});

	it("derives the loopback endpoint from the bridge origin", () => {
		expect(uploadBridgeEndpoint("http://127.0.0.1:9235")).toBe("http://127.0.0.1:9235/musepi/upload-request");
		expect(uploadBridgeEndpoint("http://127.0.0.1:9235/")).toBe("http://127.0.0.1:9235/musepi/upload-request");
	});

	it("keeps host, accept and file names in the operation target", () => {
		expect(uploadTargetLabel("example.com", ["image/png"], ["C:/tmp/a.png"])).toBe(
			"example.com · accept=image/png · a.png",
		);
	});
});

describe("browser upload — site-initiated chooser", () => {
	it("cancels the intercepted chooser and never sets files when the user declines", async () => {
		const calls = { cancel: 0, setFiles: [] as string[][] };
		const outcome = await completeInterceptedUpload(
			{
				request: async () => ({ accepted: false, reason: "canceled" }),
				setFiles: async files => {
					calls.setFiles.push(files);
				},
				cancel: async () => {
					calls.cancel += 1;
				},
			},
			request(),
			42,
		);
		expect(outcome).toEqual({ accepted: false, reason: "canceled" });
		expect(calls.cancel).toBe(1);
		expect(calls.setFiles).toEqual([]);
	});

	it("hands the picked files to the intercepted input on accept", async () => {
		const setFiles: Array<{ files: string[]; backendNodeId: number }> = [];
		let canceled = false;
		const outcome = await completeInterceptedUpload(
			{
				request: async () => ({ accepted: true, paths: ["C:/tmp/a.png"] }),
				setFiles: async (files, backendNodeId) => {
					setFiles.push({ files, backendNodeId });
				},
				cancel: async () => {
					canceled = true;
				},
			},
			request({ accept: ["image/png"], multiple: true }),
			7,
		);
		expect(outcome).toEqual({ accepted: true });
		expect(setFiles).toEqual([{ files: ["C:/tmp/a.png"], backendNodeId: 7 }]);
		expect(canceled).toBe(false);
	});

	it("treats an accept without paths as a cancellation", async () => {
		let canceled = false;
		const outcome = await completeInterceptedUpload(
			{
				request: async () => ({ accepted: true, paths: [] }),
				setFiles: async () => {
					throw new Error("must not set files");
				},
				cancel: async () => {
					canceled = true;
				},
			},
			request(),
			1,
		);
		expect(outcome).toEqual({ accepted: false, reason: "canceled" });
		expect(canceled).toBe(true);
	});
});

describe("browser upload — agent tab.uploadFile", () => {
	it("does not touch the input when the user cancels", async () => {
		const uploaded: string[][] = [];
		const run = completeAgentUpload(
			{
				request: async () => ({ accepted: false, reason: "canceled" }),
				upload: async files => {
					uploaded.push(files);
				},
			},
			request({ mode: "agent", paths: ["C:/tmp/a.png"] }),
			["C:/tmp/a.png"],
		);
		await expect(run).rejects.toThrow("Upload canceled by the user");
		expect(uploaded).toEqual([]);
	});

	it("uploads the validated paths once the user allows it", async () => {
		const uploaded: string[][] = [];
		await completeAgentUpload(
			{
				request: async () => ({ accepted: true }),
				upload: async files => {
					uploaded.push(files);
				},
			},
			request({ mode: "agent", paths: ["C:/tmp/a.png"] }),
			["C:/tmp/a.png"],
		);
		expect(uploaded).toEqual([["C:/tmp/a.png"]]);
	});

	it("names the timeout and the unsupported backend in the error", () => {
		expect(uploadCanceledError("timeout", "example.com").message).toContain("timed out");
		expect(uploadCanceledError("unsupported", "example.com").message).toContain("tab.uploadFile(selector, path)");
		expect(uploadCanceledError(undefined, "example.com").message).toContain("canceled by the user");
	});

	it("gates an enriched handle's uploadFile and keeps a native path for the gate", async () => {
		const native: string[][] = [];
		const handle = {
			uploadFile: async (...files: string[]) => {
				native.push(files);
			},
			fill: async () => {},
			click: async () => {},
		} as unknown as Parameters<typeof toActionableHandle>[0];
		const gated: string[][] = [];
		const enriched = toActionableHandle(handle, {
			tracker: {} as never,
			target: "input[type=file]",
			upload: async (_handle, files) => {
				gated.push(files);
			},
		});
		await enriched.uploadFile("C:/tmp/a.png");
		expect(gated).toEqual([["C:/tmp/a.png"]]);
		expect(native).toEqual([]);
		// The gate itself writes through the original, never through itself.
		await uploadFilesOnHandle(enriched, ["C:/tmp/b.png"]);
		expect(native).toEqual([["C:/tmp/b.png"]]);
	});

	it("keeps the native uploadFile when no managed-browser gate is installed", async () => {
		const native: string[][] = [];
		const handle = {
			uploadFile: async (...files: string[]) => {
				native.push(files);
			},
			fill: async () => {},
			click: async () => {},
		} as unknown as Parameters<typeof toActionableHandle>[0];
		const enriched = toActionableHandle(handle);
		await enriched.uploadFile("C:/tmp/a.png");
		expect(native).toEqual([["C:/tmp/a.png"]]);
	});
});
