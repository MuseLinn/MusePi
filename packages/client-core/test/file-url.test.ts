import { describe, expect, it } from "bun:test";
import { fileUrlFromPath } from "../src/tool-render/util";

describe("fileUrlFromPath", () => {
	it("normalizes Windows drive paths into file URLs", () => {
		expect(fileUrlFromPath("C:\\Users\\me\\shot.png")).toBe("file:///C:/Users/me/shot.png");
		expect(fileUrlFromPath("D:/media/clip.mp4")).toBe("file:///D:/media/clip.mp4");
	});

	it("normalizes UNC paths into file URLs", () => {
		expect(fileUrlFromPath("\\\\server\\share\\a.png")).toBe("file://server/share/a.png");
	});

	it("keeps POSIX paths and encodes reserved characters", () => {
		expect(fileUrlFromPath("/tmp/图 1.png")).toBe("file:///tmp/%E5%9B%BE%201.png");
	});

	it("normalizes existing file URLs", () => {
		expect(fileUrlFromPath("file://D:\\media\\clip.mp4")).toBe("file:///D:/media/clip.mp4");
		expect(fileUrlFromPath("file:///tmp/f.ts")).toBe("file:///tmp/f.ts");
	});

	it("passes non-file values through", () => {
		expect(fileUrlFromPath("https://example.com/a.png")).toBe("https://example.com/a.png");
		expect(fileUrlFromPath("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
	});
});
