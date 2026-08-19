import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { collectExtensionModes, collectSlotComponents } from "../src/daemon/extension-artifact-compiler.js";

const EXAMPLE_EXT = new URL("../examples/extension-component/index.ts", import.meta.url).pathname.replace(
	/^\/([A-Za-z]:)/,
	"$1",
);

describe("extension slot components", () => {
	test("compiles an active extension-module component to host-bound ESM", async () => {
		const components = await collectSlotComponents(
			[{ kind: "extension-module", state: "active", path: EXAMPLE_EXT }],
			process.cwd(),
		);
		expect(components).toHaveLength(1);
		const c = components[0]!;
		expect(c.slot).toBe("settings.extensions");
		expect(c.label).toBe("Greeting card");
		// Compiled output binds to the HOST react instance — never a bundled
		// copy (double react would null the hooks dispatcher).
		expect(c.code).toContain("window.MusePiReact");
		expect(c.code).not.toContain('from"react"');
		expect(c.error).toBeUndefined();
	}, 60_000);

	test("skips non-extension-module entries and shadowed states", async () => {
		const components = await collectSlotComponents(
			[
				{ kind: "skill", state: "active", path: "C:/tmp/skill.md" },
				{ kind: "extension-module", state: "disabled", path: EXAMPLE_EXT },
			],
			process.cwd(),
		);
		expect(components).toHaveLength(0);
	});

	test("collectExtensionModes skips malformed mode entries without throwing", async () => {
		// A temp extension whose modes array contains a malformed entry
		// (missing id) plus a valid one — the malformed mode must be
		// skipped and the valid one collected.
		const dir = await mkdtemp(path.join(tmpdir(), "ext-modes-def-"));
		const modPath = `${dir}/modes.ts`;
		await writeFile(
			modPath,
			`import type { ExtensionAPI } from "@musepi/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
	// @ts-expect-error malformed mode (missing id) — must be skipped
	pi.registerMode({ label: "Broken" });
	pi.registerMode({ id: "valid-mode", label: "Valid", description: "ok" });
}
`,
		);
		try {
			const modes = await collectExtensionModes(
				[{ kind: "extension-module", state: "active", path: modPath }],
				process.cwd(),
			);
			// The malformed literal is filtered by the shape guard; the
			// valid mode surfaces (or the whole call resolves without
			// throwing, which is the contract under test).
			expect(Array.isArray(modes)).toBe(true);
			expect(modes.some(m => m.id === "valid-mode")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("extension rpc + skills + toolviews", () => {
	test("invokeExtensionRpc dispatches a registered handler with ctx", async () => {
		const { invokeExtensionRpc } = await import("../src/daemon/extension-artifact-compiler.js");
		const dir = await mkdtemp(path.join(tmpdir(), "ext-rpc-"));
		const modPath = `${dir}/rpc.ts`;
		await writeFile(
			modPath,
			`export default function (pi: any): void {
	pi.registerRpc("echo", (params: unknown, ctx: { cwd: string; sessionId?: string }) => ({ ...(params as object), cwd: ctx.cwd, sessionId: ctx.sessionId }));
	pi.registerRpc("boom", () => { throw new Error("rpc boom"); });
}
`,
		);
		try {
			const result = await invokeExtensionRpc(modPath, process.cwd(), "echo", { x: 1 }, { cwd: "/tmp", sessionId: "s1" });
			expect(result).toEqual({ x: 1, cwd: "/tmp", sessionId: "s1" });
			await expect(invokeExtensionRpc(modPath, process.cwd(), "missing", {}, { cwd: "/tmp" })).rejects.toThrow(
				/unknown extension rpc method "missing"/,
			);
			await expect(invokeExtensionRpc(modPath, process.cwd(), "boom", {}, { cwd: "/tmp" })).rejects.toThrow("rpc boom");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("collectExtensionSkills returns virtual skills with extension identity", async () => {
		const { collectExtensionSkills } = await import("../src/daemon/extension-artifact-compiler.js");
		const dir = await mkdtemp(path.join(tmpdir(), "ext-skills-"));
		const modPath = `${dir}/skills.ts`;
		await writeFile(
			modPath,
			`export default function (pi: any): void {
	pi.registerSkill({ name: "virt-skill", description: "virtual skill", content: "# Virtual\\n\\nbody" });
}
`,
		);
		try {
			const skills = await collectExtensionSkills(
				[{ kind: "extension-module", state: "active", path: modPath }],
				process.cwd(),
			);
			expect(skills).toHaveLength(1);
			expect(skills[0]).toMatchObject({
				name: "virt-skill",
				description: "virtual skill",
				content: "# Virtual\n\nbody",
				extensionPath: modPath,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("collectToolViews compiles a valid view and carries error for a broken one", async () => {
		const { collectToolViews } = await import("../src/daemon/extension-artifact-compiler.js");
		const dir = await mkdtemp(path.join(tmpdir(), "ext-toolviews-"));
		const modPath = `${dir}/toolviews.ts`;
		const viewPath = `${dir}/view.tsx`;
		await writeFile(
			viewPath,
			`export default { Summary: () => null, Body: () => null };
`,
		);
		await writeFile(
			modPath,
			`export default function (pi: any): void {
	pi.registerToolView("my_tool", { moduleUrl: "./view.tsx", label: "My View" });
	pi.registerToolView("broken_tool", { moduleUrl: "./missing.tsx" });
}
`,
		);
		try {
			const views = await collectToolViews(
				[{ kind: "extension-module", state: "active", path: modPath }],
				process.cwd(),
			);
			expect(views).toHaveLength(2);
			const ok = views.find(v => v.tool === "my_tool")!;
			expect(ok.error).toBeUndefined();
			expect(ok.code).toContain("export");
			expect(ok.code).toContain("Summary");
			const broken = views.find(v => v.tool === "broken_tool")!;
			expect(broken.code).toBe("");
			expect(broken.error).toBeDefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
