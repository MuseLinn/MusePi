const { afterAll, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

// The upload tests never reach Electron; skip the one-time scheme hook.
process.env.MUSEPI_MANAGED_BROWSER_SCHEMES_REGISTERED = "1";
const {
	ManagedBrowserController,
	sanitizeUploadRequest,
	validateUploadPaths,
	uploadFilters,
} = require("../electron/managed-browser.cjs");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-upload-"));
const uploadedFile = path.join(tmpDir, "note.txt");
fs.writeFileSync(uploadedFile, "hello");

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeOwner() {
	const sent = [];
	return {
		sent,
		owner: {
			isDestroyed: () => false,
			webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
		},
	};
}

function fakeRequest(body, headers = {}) {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]);
	req.method = "POST";
	req.url = "/musepi/upload-request";
	req.headers = { "content-type": "application/json", ...headers };
	return req;
}

function fakeResponse() {
	const res = {
		status: 0,
		body: "",
		headersSent: false,
		writeHead(status) {
			this.status = status;
			this.headersSent = true;
		},
		end(chunk) {
			if (chunk !== undefined) this.body = String(chunk);
			this.done?.();
		},
	};
	res.finished = new Promise(resolve => {
		res.done = resolve;
	});
	return res;
}

function controllerWithOwner() {
	const controller = new ManagedBrowserController();
	const { sent, owner } = fakeOwner();
	controller.owner = owner;
	return { controller, sent };
}

describe("managed browser upload — request validation", () => {
	it("accepts an absolute regular file and rejects relative or missing paths", () => {
		expect(validateUploadPaths([uploadedFile])).toEqual([uploadedFile]);
		expect(validateUploadPaths(["relative.txt"])).toBeNull();
		expect(validateUploadPaths([path.join(tmpDir, "missing.txt")])).toBeNull();
		expect(validateUploadPaths([])).toBeNull();
		expect(validateUploadPaths([tmpDir])).toBeNull();
	});

	it("sanitizes site metadata and keeps agent paths only after validation", () => {
		expect(
			sanitizeUploadRequest({
				mode: "site",
				site: { host: "example.com", url: "https://user:pass@example.com/u", title: "Up\u0000load" },
				accept: "text/plain,.pdf",
				multiple: true,
			}),
		).toEqual({
			mode: "site",
			site: { host: "example.com", url: "https://example.com/u", title: "Upload" },
			accept: ["text/plain", ".pdf"],
			multiple: true,
		});
		expect(
			sanitizeUploadRequest({
				mode: "agent",
				site: { host: "example.com", url: "https://example.com/" },
				paths: [uploadedFile],
			}),
		).toMatchObject({ mode: "agent", paths: [uploadedFile] });
		expect(sanitizeUploadRequest({ mode: "agent", paths: ["nope.txt"] })).toBeNull();
	});

	it("builds OS filters from MIME families and extensions", () => {
		const filters = uploadFilters(["image/*", ".pdf"]);
		expect(filters[0].extensions).toContain("png");
		expect(filters[0].extensions).toContain("pdf");
		expect(filters.at(-1)).toEqual({ name: "All files", extensions: ["*"] });
	});
});

describe("managed browser upload — request/response branch", () => {
	it("pushes the card, then resolves with the accepted absolute paths", async () => {
		const { controller, sent } = controllerWithOwner();
		const pending = controller.requestUploadConsent({
			mode: "site",
			site: { host: "example.com", url: "https://example.com/u" },
			accept: ["text/plain"],
			multiple: false,
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].channel).toBe("managed-browser:upload-request");
		expect(sent[0].payload).toMatchObject({
			mode: "site",
			site: { host: "example.com" },
			accept: ["text/plain"],
			multiple: false,
			names: [],
		});
		expect(controller.resolveUploadResult({
			requestId: sent[0].payload.requestId,
			accepted: true,
			paths: [uploadedFile],
		})).toEqual({ ok: true });
		expect(await pending).toEqual({ accepted: true, paths: [uploadedFile] });
	});

	it("turns a renderer cancel into a canceled result", async () => {
		const { controller, sent } = controllerWithOwner();
		const pending = controller.requestUploadConsent({
			mode: "site",
			site: { host: "example.com", url: "https://example.com/u" },
			accept: [],
			multiple: false,
		});
		controller.resolveUploadResult({ requestId: sent[0].payload.requestId, accepted: false });
		expect(await pending).toEqual({ accepted: false, reason: "canceled" });
	});

	it("rejects a renderer-supplied path that is not an absolute file", async () => {
		const { controller, sent } = controllerWithOwner();
		const pending = controller.requestUploadConsent({
			mode: "site",
			site: { host: "example.com", url: "https://example.com/u" },
			accept: [],
			multiple: false,
		});
		expect(controller.resolveUploadResult({
			requestId: sent[0].payload.requestId,
			accepted: true,
			paths: ["relative.txt"],
		})).toEqual({ ok: false });
		expect(await pending).toEqual({ accepted: false, reason: "invalid" });
	});

	it("agent mode reuses the worker's validated paths and shows names", async () => {
		const { controller, sent } = controllerWithOwner();
		const pending = controller.requestUploadConsent({
			mode: "agent",
			site: { host: "example.com", url: "https://example.com/u" },
			accept: [],
			multiple: false,
			paths: [uploadedFile],
		});
		expect(sent[0].payload).toMatchObject({ mode: "agent", names: ["note.txt"] });
		controller.resolveUploadResult({ requestId: sent[0].payload.requestId, accepted: true });
		expect(await pending).toEqual({ accepted: true, paths: [uploadedFile] });
	});

	it("answers busy for a second card and unblocks on cancel", async () => {
		const { controller } = controllerWithOwner();
		const first = controller.requestUploadConsent({
			mode: "site",
			site: { host: "a.test", url: "https://a.test/" },
			accept: [],
			multiple: false,
		});
		expect(
			await controller.requestUploadConsent({
				mode: "site",
				site: { host: "b.test", url: "https://b.test/" },
				accept: [],
				multiple: false,
			}),
		).toEqual({ accepted: false, reason: "busy" });
		controller.cancelPendingUpload();
		expect(await first).toEqual({ accepted: false, reason: "canceled" });
	});

	it("does not open the picker without a waiting card", async () => {
		const { controller } = controllerWithOwner();
		expect(await controller.pickUploadFiles({ multiple: true })).toEqual({ paths: [] });
	});
});

describe("managed browser upload — loopback HTTP endpoint", () => {
	it("rejects a request carrying a browser Origin", async () => {
		const { controller, sent } = controllerWithOwner();
		const res = fakeResponse();
		controller.handleUploadRequestHttp(
			fakeRequest({ mode: "site" }, { origin: "https://evil.test" }),
			res,
		);
		await res.finished;
		expect(res.status).toBe(403);
		expect(sent).toEqual([]);
	});

	it("round-trips an accepted decision as JSON", async () => {
		const { controller, sent } = controllerWithOwner();
		const res = fakeResponse();
		controller.handleUploadRequestHttp(
			fakeRequest({
				mode: "site",
				site: { host: "example.com", url: "https://example.com/u" },
				accept: [".txt"],
			}),
			res,
		);
		await Bun.sleep(5);
		expect(sent[0].payload.site.host).toBe("example.com");
		controller.resolveUploadResult({
			requestId: sent[0].payload.requestId,
			accepted: true,
			paths: [uploadedFile],
		});
		await res.finished;
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ accepted: true, paths: [uploadedFile] });
	});

	it("answers invalid for a non-JSON content type", async () => {
		const { controller, sent } = controllerWithOwner();
		const res = fakeResponse();
		controller.handleUploadRequestHttp(
			fakeRequest({ mode: "site" }, { "content-type": "text/plain" }),
			res,
		);
		await res.finished;
		expect(res.status).toBe(415);
		expect(sent).toEqual([]);
	});

	it("serves the endpoint over a real loopback socket", async () => {
		const http = require("node:http");
		const { controller, sent } = controllerWithOwner();
		const server = http.createServer((req, res) => controller.handleUploadRequestHttp(req, res));
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address();
			// `node:http` (not fetch): the shared suite may run with proxy env
			// set by another test, and loopback POSTs must never leave the host.
			const responsePromise = new Promise((resolve, reject) => {
				const req = http.request(
					{
						host: "127.0.0.1",
						port,
						path: "/musepi/upload-request",
						method: "POST",
						headers: { "content-type": "application/json" },
					},
					res => {
						let body = "";
						res.setEncoding("utf8");
						res.on("data", chunk => {
							body += chunk;
						});
						res.on("end", () => resolve({ status: res.statusCode, body }));
					},
				);
				req.on("error", reject);
				req.end(
					JSON.stringify({
						mode: "site",
						site: { host: "example.com", url: "https://example.com/u" },
						accept: [".txt"],
					}),
				);
			});
			for (let attempt = 0; attempt < 200 && sent.length === 0; attempt++) await Bun.sleep(10);
			expect(sent).toHaveLength(1);
			controller.resolveUploadResult({
				requestId: sent[0].payload.requestId,
				accepted: true,
				paths: [uploadedFile],
			});
			const response = await responsePromise;
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body)).toEqual({ accepted: true, paths: [uploadedFile] });
		} finally {
			server.closeAllConnections?.();
			await new Promise(resolve => server.close(resolve));
		}
	});
});
