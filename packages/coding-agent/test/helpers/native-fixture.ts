import * as fs from "node:fs";
import * as path from "node:path";

export function createNativeFixtureTempDir(prefix: string): string {
	const root = path.resolve(import.meta.dir, "../../../../.tmp");
	fs.mkdirSync(root, { recursive: true });
	return fs.mkdtempSync(path.join(root, prefix));
}

export async function compileNativeFixture(
	sourcePath: string,
	outfile: string,
	define?: Record<string, string>,
): Promise<void> {
	const build = await Bun.build({
		entrypoints: [sourcePath],
		compile: { outfile },
		define,
		throw: false,
	});
	if (!build.success) throw new Error(build.logs.map(String).join("\n"));
}
