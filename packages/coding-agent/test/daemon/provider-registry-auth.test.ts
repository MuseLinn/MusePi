import { afterAll, beforeAll, expect, test } from "bun:test";
import { DaemonSessionHost } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

let isolatedAgentDir = "";

beforeAll(async () => {
	isolatedAgentDir = await isolateAgentDirForTest("musepi-provider-registry-auth-");
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedAgentDir);
}, 30_000);

test("session-less provider setup keeps the shared credential store usable", async () => {
	const host = new DaemonSessionHost({ cwd: isolatedAgentDir });
	let closeAuthStorage: (() => void) | undefined;
	try {
		const registry = await host.ensureRegistry();
		expect(registry).not.toBeNull();
		closeAuthStorage = () => registry!.authStorage.close();
		await registry!.authStorage.importApiKey("agnes-global", "sk-test-provider-bootstrap");
		expect(registry!.authStorage.has("agnes-global")).toBe(true);
		expect(registry!.authStorage.listStoredCredentials("agnes-global")).toHaveLength(1);
	} finally {
		host.dispose();
		closeAuthStorage?.();
	}
}, 60_000);
