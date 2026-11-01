import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { collectSlotComponents, collectToolViews } from "../../coding-agent/src/daemon/extension-artifact-compiler";
import { hostReactBindings } from "../src/lib/slot-host";

describe("extension React host bindings", () => {
	it("keeps the bundled icon graph on the host React context", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "ext-react-icons-"));
		const entry = path.join(dir, "index.ts");
		await writeFile(
			entry,
			`export default function (pi: any): void { pi.registerComponent({ slot: "app.capability", moduleUrl: "./page.tsx" }); }`,
		);
		await writeFile(
			path.join(dir, "page.tsx"),
			`import { Icon } from ${JSON.stringify(path.resolve("src/vendor/oc-icons").replaceAll("\\", "/"))};
			export default function Page() { return <Icon name="plug" />; }`,
		);
		const previous = window.MusePiReact;
		window.MusePiReact = hostReactBindings;
		try {
			const components = await collectSlotComponents(
				[{ kind: "plugin-module", state: "active", path: entry }],
				process.cwd(),
			);
			expect(components[0]?.error).toBeUndefined();
			const module = await import(
				`data:text/javascript;base64,${Buffer.from(components[0]!.code).toString("base64")}`
			);
			expect(renderToStaticMarkup(module.default())).toContain("svg");
		} finally {
			window.MusePiReact = previous;
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("compiles and executes the Android tool view on host React", async () => {
		const entry = path.resolve("../coding-agent/src/bundled-plugins/android-emulator/index.ts");
		const previous = window.MusePiReact;
		window.MusePiReact = hostReactBindings;
		try {
			const views = await collectToolViews([{ kind: "plugin-module", state: "active", path: entry }], process.cwd());
			expect(views).toHaveLength(1);
			expect(views[0]).toMatchObject({ tool: "android_emulator", label: "Android 模拟器" });
			expect(views[0]?.error).toBeUndefined();
			const module = await import(`data:text/javascript;base64,${Buffer.from(views[0]!.code).toString("base64")}`);
			const summary = module.default.Summary({ args: { action: "screenshot", device: "emulator-5554" } });
			expect(renderToStaticMarkup(summary)).toContain("截图 · emulator-5554");
			expect(renderToStaticMarkup(module.default.Icon())).toContain("svg");
		} finally {
			window.MusePiReact = previous;
		}
	}, 60_000);
});
