import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { PresentTool } from "@musepi/pi-coding-agent/tools/present";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

function session(cwd: string): ToolSession {
	return { cwd, hasUI: false } as unknown as ToolSession;
}

describe("present", () => {
	it("records absolute paths for existing regular files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "present-tool-"));
		dirs.push(dir);
		await Bun.write(path.join(dir, "report.md"), "done");
		const result = await new PresentTool(session(dir), 4).execute("call", {
			files: [{ path: "report.md", description: "Final report" }],
		});
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain(path.join(dir, "report.md"));
		expect(result.details?.files).toEqual([{ path: path.join(dir, "report.md"), description: "Final report" }]);
	});

	it("refuses a missing path and a directory", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "present-tool-"));
		dirs.push(dir);
		const tool = new PresentTool(session(dir), 4);
		await expect(tool.execute("call", { files: [{ path: "missing.md" }] })).rejects.toThrow("file not found");
		await expect(tool.execute("call", { files: [{ path: "." }] })).rejects.toThrow("not a regular file");
	});

	it("enforces the file-count limit", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "present-tool-"));
		dirs.push(dir);
		await Bun.write(path.join(dir, "a.md"), "a");
		const tool = new PresentTool(session(dir), 1);
		await expect(tool.execute("call", { files: [{ path: "a.md" }, { path: "a.md" }] })).rejects.toThrow("1-1 files");
	});
});
