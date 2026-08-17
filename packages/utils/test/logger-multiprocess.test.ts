import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const loggerModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/logger.ts")).href;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeProbe(logsDir: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-probe-"));
	roots.push(root);
	const releasePath = path.join(logsDir, ".release");
	const probePath = path.join(root, "probe.ts");
	await Bun.write(
		probePath,
		`import * as fs from "node:fs";\n` +
			`import { info, setTransports } from ${JSON.stringify(loggerModuleUrl)};\n` +
			`setTransports({ file: ${JSON.stringify(logsDir)} });\n` +
			`info("multiprocess probe");\n` +
			`fs.writeSync(1, "ready\\n");\n` +
			`await new Promise<void>(resolve => {\n` +
			`\tconst watcher = fs.watch(${JSON.stringify(logsDir)}, (_event, name) => {\n` +
			`\t\tif (name !== ".release") return;\n` +
			`\t\twatcher.close();\n` +
			`\t\tresolve();\n` +
			`\t});\n` +
			`\tif (fs.existsSync(${JSON.stringify(releasePath)})) {\n` +
			`\t\twatcher.close();\n` +
			`\t\tresolve();\n` +
			`\t}\n` +
			`});\n` +
			`setTransports({ file: false });\n`,
	);
	return probePath;
}

describe("multiprocess file logging", () => {
	it("prunes completed PID namespaces across short-lived invocations", async () => {
		const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-retention-"));
		roots.push(logsDir);
		const exited = Array.from({ length: 7 }, () =>
			Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" }),
		);
		expect(await Promise.all(exited.map(proc => proc.exited))).toEqual(Array(7).fill(0));

		const date = "2026-07-01";
		for (const [index, proc] of exited.entries()) {
			const logPath = path.join(logsDir, `omp.${date}.${proc.pid}.log`);
			await Bun.write(logPath, `completed process ${proc.pid}`);
			await fs.utimes(logPath, index + 1, index + 1);
			await Bun.write(path.join(logsDir, `.omp.${proc.pid}-audit.json`), "{}");
		}

		await Bun.write(path.join(logsDir, ".release"), "");
		const probePath = await makeProbe(logsDir);
		const current = Bun.spawn([process.execPath, probePath], { stdout: "ignore", stderr: "pipe" });
		expect(await current.exited).toBe(0);

		const entries = await fs.readdir(logsDir);
		const completedLogs = entries.filter(name => name.startsWith(`omp.${date}.`));
		expect(completedLogs).toHaveLength(5);
		expect(entries.filter(name => name.endsWith("-audit.json"))).toEqual([`.omp.${current.pid}-audit.json`]);
	});
});
