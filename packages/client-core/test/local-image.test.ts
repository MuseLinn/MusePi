import { describe, expect, it } from "bun:test";
import { isLocalImageSrc, resolveLocalImages } from "../src/components/transcript/Markdown";

function stubImg(src: string, connected = true) {
	let current = src;
	return {
		getAttribute(name: string) {
			return name === "src" ? current : null;
		},
		set src(value: string) {
			current = value;
		},
		get src() {
			return current;
		},
		isConnected: connected,
	};
}

describe("isLocalImageSrc", () => {
	it("accepts absolute, home, relative, and file:// paths", () => {
		expect(isLocalImageSrc("/Users/me/x.png")).toBe(true);
		expect(isLocalImageSrc("~/Desktop/shot.png")).toBe(true);
		expect(isLocalImageSrc("./rel.png")).toBe(true);
		expect(isLocalImageSrc("../up.gif")).toBe(true);
		expect(isLocalImageSrc("file:///Users/me/x.png")).toBe(true);
		expect(isLocalImageSrc("folder/pic.jpeg")).toBe(true);
	});

	it("rejects remote/data/blob URLs and non-images", () => {
		expect(isLocalImageSrc("https://x.com/a.png")).toBe(false);
		expect(isLocalImageSrc("http://x.com/a.png")).toBe(false);
		expect(isLocalImageSrc("data:image/png;base64,AAAA")).toBe(false);
		expect(isLocalImageSrc("blob:file/123")).toBe(false);
		expect(isLocalImageSrc("notes.md")).toBe(false);
		expect(isLocalImageSrc("/etc/hosts")).toBe(false);
	});
});

describe("resolveLocalImages", () => {
	it("replaces local srcs with data URLs via the bridge", async () => {
		const img = stubImg("/tmp/real.png");
		const calls: string[] = [];
		const bridge = {
			readFileDataUrl: async (p: string) => {
				calls.push(p);
				return { dataUrl: `data:image/png;base64,${p.length}` };
			},
		};
		const root = { querySelectorAll: () => [img] };
		resolveLocalImages(root as never, bridge, new Map());
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["/tmp/real.png"]);
		expect(img.src).toBe("data:image/png;base64,13");
	});

	it("strips the file:// prefix before calling the bridge", async () => {
		const img = stubImg("file:///Users/me/a.png");
		const calls: string[] = [];
		const bridge = {
			readFileDataUrl: async (p: string) => {
				calls.push(p);
				return { dataUrl: "data:image/png;base64,x" };
			},
		};
		resolveLocalImages({ querySelectorAll: () => [img] } as never, bridge, new Map());
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["/Users/me/a.png"]);
	});

	it("hits the cache without re-invoking the bridge", async () => {
		const img1 = stubImg("/tmp/c.png");
		const img2 = stubImg("/tmp/c.png");
		let calls = 0;
		const bridge = {
			readFileDataUrl: async () => {
				calls += 1;
				return { dataUrl: "data:image/png;base64,cached" };
			},
		};
		const cache = new Map<string, string>();
		resolveLocalImages({ querySelectorAll: () => [img1] } as never, bridge, cache);
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(1);
		resolveLocalImages({ querySelectorAll: () => [img2] } as never, bridge, cache);
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(img2.src).toBe("data:image/png;base64,cached");
	});

	it("skips remote images and disconnected elements", async () => {
		const remote = stubImg("https://x.com/a.png");
		const stale = stubImg("/tmp/s.png", false);
		let calls = 0;
		const bridge = {
			readFileDataUrl: async () => {
				calls += 1;
				return { dataUrl: "data:image/png;base64,x" };
			},
		};
		resolveLocalImages({ querySelectorAll: () => [remote, stale] } as never, bridge, new Map());
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(1); // only the disconnected local one attempted
		expect(remote.src).toBe("https://x.com/a.png");
	});

	it("leaves src unchanged when the bridge errors", async () => {
		const img = stubImg("/tmp/bad.png");
		const bridge = {
			readFileDataUrl: async () => ({ error: "unsupported type" }),
		};
		resolveLocalImages({ querySelectorAll: () => [img] } as never, bridge, new Map());
		await Promise.resolve();
		await Promise.resolve();
		expect(img.src).toBe("/tmp/bad.png");
	});
});

describe("resolveLocalImages with base", () => {
	it("resolves relative srcs against the base", async () => {
		const img = stubImg("pic.png");
		const calls: string[] = [];
		const bridge = {
			readFileDataUrl: async (p: string) => {
				calls.push(p);
				return { dataUrl: "data:image/png;base64,x" };
			},
		};
		resolveLocalImages({ querySelectorAll: () => [img] } as never, bridge, new Map(), "/tmp/ws");
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["/tmp/ws/pic.png"]);
		expect(img.src).toBe("data:image/png;base64,x");
	});

	it("leaves absolute paths untouched with a base present", async () => {
		const img = stubImg("/Users/me/x.png");
		const calls: string[] = [];
		const bridge = {
			readFileDataUrl: async (p: string) => {
				calls.push(p);
				return { dataUrl: "d" };
			},
		};
		resolveLocalImages({ querySelectorAll: () => [img] } as never, bridge, new Map(), "/tmp/ws");
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["/Users/me/x.png"]);
	});
});
