import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connectorStatePath, readConnectorState, setConnectorEnabled } from "./state";

async function tempAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), "musepi-connector-state-"));
}

describe("connector state", () => {
	it("treats a missing file as nothing enabled", async () => {
		const agentDir = await tempAgentDir();
		const state = await readConnectorState(agentDir);
		expect(state).toEqual({ version: 1, connectors: {} });
	});

	it("serializes concurrent toggles without dropping entries", async () => {
		const agentDir = await tempAgentDir();
		await Promise.all([setConnectorEnabled("alpha", true, agentDir), setConnectorEnabled("beta", true, agentDir)]);

		const state = await readConnectorState(agentDir);
		expect(state.connectors.alpha?.enabled).toBe(true);
		expect(state.connectors.beta?.enabled).toBe(true);
		expect(typeof state.connectors.alpha?.connectedAt).toBe("number");
	});

	it("keeps connectedAt when disabling and preserves the on-disk shape", async () => {
		const agentDir = await tempAgentDir();
		const enabled = await setConnectorEnabled("alpha", true, agentDir);
		const connectedAt = enabled.connectors.alpha?.connectedAt;
		expect(connectedAt).toBeNumber();

		const disabled = await setConnectorEnabled("alpha", false, agentDir);
		expect(disabled.connectors.alpha).toEqual({ enabled: false, connectedAt });

		const raw = JSON.parse(await fs.readFile(connectorStatePath(agentDir), "utf8"));
		expect(raw).toMatchObject({ version: 1, connectors: { alpha: { enabled: false, connectedAt } } });
	});

	it("starts empty when the file is not valid JSON", async () => {
		const agentDir = await tempAgentDir();
		await fs.mkdir(path.dirname(connectorStatePath(agentDir)), { recursive: true });
		await fs.writeFile(connectorStatePath(agentDir), "{not json", "utf8");

		expect(await readConnectorState(agentDir)).toEqual({ version: 1, connectors: {} });
	});
});
