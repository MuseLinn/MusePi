import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileComponentModule } from "./extension-artifact-compiler";

/**
 * The artifact compiler bundles every import except its host bridges. A module
 * that carries React context must be bridged: a bundled copy would read its
 * own default context instead of the host provider.
 */
describe("extension artifact compiler host bridges", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("binds prompt-dialog imports to the host provider hooks", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-artifact-"));
		await fs.mkdir(path.join(dir, "lib"));
		await fs.writeFile(
			path.join(dir, "lib", "prompt-dialog.ts"),
			[
				'export const LOCAL_ONLY_MARKER = "bundled-prompt-copy";',
				"export function useConfirm(): { confirm(message: string): Promise<boolean> } {",
				"	return { confirm: async () => LOCAL_ONLY_MARKER.length > 0 };",
				"}",
			].join("\n"),
		);
		const entry = path.join(dir, "component.tsx");
		await fs.writeFile(
			entry,
			[
				'import { useConfirm } from "./lib/prompt-dialog";',
				"export default function Component() {",
				"	const { confirm } = useConfirm();",
				'	return <button onClick={() => void confirm("stop?")} />;',
				"}",
			].join("\n"),
		);

		const { code } = await compileComponentModule(entry);

		expect(code).toContain("MusePiPromptDialog");
		expect(code).not.toContain("LOCAL_ONLY_MARKER");
	});
});
