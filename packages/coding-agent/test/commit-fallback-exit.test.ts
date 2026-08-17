/**
 * The fallback commit path (agent failed / no proposal) must be signalled to
 * callers so a degraded numstat commit is distinguishable from a legitimate
 * single-commit decision (issue #7835).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { runAgenticCommit } from "@musepi/pi-coding-agent/commit/agentic";
import * as agentModule from "@musepi/pi-coding-agent/commit/agentic/agent";
import * as modelSelection from "@musepi/pi-coding-agent/commit/model-selection";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import * as sdkModule from "@musepi/pi-coding-agent/sdk";
import * as gitModule from "@musepi/pi-coding-agent/utils/git";

const NUMSTAT = [{ path: "src/a.ts", additions: 1, deletions: 0 }];
let authStorage: AuthStorage | undefined;

function mockModelResolution() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
	vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({
		model: { name: "test-primary", provider: "test", id: "test" } as never,
		apiKey: "test-key",
	});
	vi.spyOn(modelSelection, "resolveSmolModel").mockResolvedValue({
		model: { name: "test-smol", provider: "test", id: "test" } as never,
		apiKey: "test-key",
		thinkingLevel: undefined,
	});
	return model;
}

async function setupRepoMocks() {
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.reload();
	vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	vi.spyOn(sdkModule, "discoverContextFiles").mockResolvedValue([]);
	vi.spyOn(gitModule.diff, "changedFiles").mockResolvedValue(["src/a.ts"]);
	vi.spyOn(gitModule.diff, "numstat").mockResolvedValue(NUMSTAT);
	vi.spyOn(gitModule, "commit").mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as never);
}

afterEach(() => {
	authStorage?.close();
	authStorage = undefined;
	vi.restoreAllMocks();
	delete process.env.PI_COMMIT_TEST_FALLBACK;
});

describe("runAgenticCommit fallback signalling (issue #7835)", () => {
	it("reports usedFallback when the fallback commit path is forced", async () => {
		mockModelResolution();
		await setupRepoMocks();
		process.env.PI_COMMIT_TEST_FALLBACK = "true";

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(gitModule.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: true });
	});

	it("reports usedFallback when the commit agent throws before completing", async () => {
		mockModelResolution();
		await setupRepoMocks();
		vi.spyOn(agentModule, "runCommitAgentSession").mockRejectedValue(new Error("model unreachable"));

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(gitModule.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: true });
	});

	it("reports usedFallback when the agent completes without a proposal", async () => {
		mockModelResolution();
		await setupRepoMocks();
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({} as never);
		}) as never);

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(gitModule.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: true });
	});

	it("reports a clean run when the agent produces a proposal", async () => {
		mockModelResolution();
		await setupRepoMocks();
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({
				proposal: {
					analysis: { type: "fix", scope: "test", details: [], issueRefs: [] },
					summary: "fixed the thing",
					warnings: [],
				},
			} as never);
		}) as never);

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(gitModule.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: false });
	});
});
