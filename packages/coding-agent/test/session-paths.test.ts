import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeDefaultSessionDir,
	peekDefaultSessionDir,
	resolveManagedSessionRoot,
} from "@musepi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@musepi/pi-coding-agent/session/session-storage";

const cleanup: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const name = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy session directory migration", () => {
	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(source, "live-before\n");
		fs.writeFileSync(destination, "stale\n");
		const fd = fs.openSync(source, "a");

		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(fd, "live-after\n");
		fs.closeSync(fd);

		expect(fs.readFileSync(source, "utf8")).toBe("live-before\nlive-after\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("stale\n");
	});

	test("preserves writes when an older process recreates its cached legacy directory", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.writeFileSync(destination, "canonical\n");

		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		fs.writeFileSync(recreated, "older-process-write\n");
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe("older-process-write\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("canonical\n");
	});
});

describe("slug 归一化（Windows 大小写不敏感）", () => {
	/** 现存 slug 目录的大小写变体（首个小写字母改大写，足以区分又不碰前导 `-`）。 */
	function caseVariant(dir: string): string {
		return path.join(
			path.dirname(dir),
			path.basename(dir).replace(/[a-z]/, c => c.toUpperCase()),
		);
	}

	test("现存的大小写变体目录被复用——同一项目不分裂成两个工作区", () => {
		if (process.platform !== "win32") return;
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonical = peekDefaultSessionDir(cwd, sessionsRoot);
		const variant = caseVariant(canonical);
		expect(variant).not.toBe(canonical);
		fs.mkdirSync(variant, { recursive: true });

		// 不同大小写写法的同一 cwd：落进现存变体目录，且 peek 与 compute 一致。
		const dir = computeDefaultSessionDir(cwd.toUpperCase(), storage, sessionsRoot);
		expect(dir).toBe(variant);
		expect(peekDefaultSessionDir(cwd.toUpperCase(), sessionsRoot)).toBe(variant);
	});

	test("resolveManagedSessionRoot 认领大小写变体目录（GC/归档不误判外部目录）", () => {
		if (process.platform !== "win32") return;
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const variant = caseVariant(peekDefaultSessionDir(cwd, sessionsRoot));
		fs.mkdirSync(variant, { recursive: true });
		expect(resolveManagedSessionRoot(variant, cwd)).toBe(sessionsRoot);
		// 负契约：无关目录不归我们管。
		expect(resolveManagedSessionRoot(path.join(sessionsRoot, "unrelated"), cwd)).toBeUndefined();
	});
});
