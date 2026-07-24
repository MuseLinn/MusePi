import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CompactionPreparation } from "../src/core/compaction/compaction.ts";
import type { SessionBeforeCompactEvent } from "../src/core/extensions/index.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	findPreviousArchive,
	handleMusepiSnapcompact,
	initMusepiSnapcompact,
} from "../src/musepi/snapcompact/native.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-snapcompact-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function settingsWithStrategy(strategy: "default" | "snapcompact"): Promise<SettingsManager> {
	const dir = await createTempDir();
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(dir, "settings.json"), JSON.stringify({ musepi: { compaction: { strategy } } }), "utf-8");
	return SettingsManager.create(dir, dir);
}

function makeEvent(
	overrides: Partial<CompactionPreparation> = {},
	branchEntries: unknown[] = [],
): SessionBeforeCompactEvent {
	const preparation: CompactionPreparation = {
		firstKeptEntryId: "entry-keep",
		messagesToSummarize: [
			{ role: "user", content: "how do we deploy?", timestamp: 1 } as never,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "with terraform apply" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "infra/main.tf" } },
				],
				timestamp: 2,
			} as never,
			{
				role: "toolResult",
				toolCallId: "c1",
				content: [{ type: "text", text: "resource aws_s3_bucket {}" }],
				isError: false,
				timestamp: 3,
			} as never,
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 12_345,
		fileOps: { read: new Set(["infra/main.tf"]), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 10_000 } as never,
		...overrides,
	};
	return {
		type: "session_before_compact",
		preparation,
		branchEntries: branchEntries as never,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

describe("handleMusepiSnapcompact", () => {
	it("returns undefined for the default strategy (pi untouched)", async () => {
		const result = handleMusepiSnapcompact(makeEvent(), await settingsWithStrategy("default"));
		expect(result).toBeUndefined();
	});

	it("produces a deterministic compaction with pi-compatible details", async () => {
		const result = handleMusepiSnapcompact(makeEvent(), await settingsWithStrategy("snapcompact"))!;
		expect(result?.compaction).toBeDefined();
		const compaction = result!.compaction!;
		expect(compaction.firstKeptEntryId).toBe("entry-keep");
		expect(compaction.tokensBefore).toBe(12_345);
		expect(compaction.summary).toContain("Resume the prior conversation");
		expect(compaction.summary).toContain("terraform apply");
		expect(compaction.summary).toContain("infra/main.tf (Read)");
		const details = compaction.details as {
			readFiles: string[];
			modifiedFiles: string[];
			snapcompact: { text: string; version: number };
		};
		expect(details.readFiles).toEqual(["infra/main.tf"]);
		expect(details.snapcompact.text).toContain("terraform apply");
		expect(details.snapcompact.version).toBeGreaterThan(0);
	});

	it("unfolds a previous archive from branch entries on the next pass", async () => {
		const sm = await settingsWithStrategy("snapcompact");
		const first = handleMusepiSnapcompact(makeEvent(), sm)!.compaction!;
		const branchEntries = [
			{ type: "compaction", summary: first.summary, details: first.details, firstKeptEntryId: "entry-keep" },
		];
		const archive = findPreviousArchive(branchEntries);
		expect(archive?.text).toContain("terraform apply");

		const second = handleMusepiSnapcompact(makeEvent({ previousSummary: first.summary }), sm)!;
		// Second pass keeps the same archive text (deterministic fold).
		const secondDetails = second.compaction!.details as { snapcompact: { text: string } };
		expect(secondDetails.snapcompact.text).toContain("terraform apply");
	});
});

describe("initMusepiSnapcompact + runner", () => {
	it("registers a native handler that answers session_before_compact emits", async () => {
		const dir = await createTempDir();
		const discovered = await discoverAndLoadExtensions([], dir, dir);
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);
		const runner = new ExtensionRunner(
			discovered.extensions,
			discovered.runtime,
			dir,
			SessionManager.inMemory(),
			modelRegistry,
		);

		expect(runner.hasHandlers("session_before_compact")).toBe(false);
		initMusepiSnapcompact(await settingsWithStrategy("snapcompact"), runner);
		expect(runner.hasHandlers("session_before_compact")).toBe(true);

		const emitted = (await runner.emit(makeEvent())) as { compaction?: { summary: string } } | undefined;
		expect(emitted?.compaction?.summary).toContain("Resume the prior conversation");
	});

	it("stays silent under the default strategy even when registered", async () => {
		const dir = await createTempDir();
		const discovered = await discoverAndLoadExtensions([], dir, dir);
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);
		const runner = new ExtensionRunner(
			discovered.extensions,
			discovered.runtime,
			dir,
			SessionManager.inMemory(),
			modelRegistry,
		);

		initMusepiSnapcompact(await settingsWithStrategy("default"), runner);
		const emitted = await runner.emit(makeEvent());
		// Native handler returns undefined → emit resolves with no compaction override.
		expect(emitted).toBeUndefined();
	});
});
