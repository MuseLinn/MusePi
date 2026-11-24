import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connectorStatePath, readConnectorState, setConnectorEnabled, setConnectorReadOnly } from "./state";

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

	it("keeps read-only across a disable and re-enable", async () => {
		const agentDir = await tempAgentDir();
		await setConnectorEnabled("alpha", true, agentDir);
		await setConnectorReadOnly("alpha", true, agentDir);

		const disabled = await setConnectorEnabled("alpha", false, agentDir);
		expect(disabled.connectors.alpha?.readOnly).toBe(true);

		const reenabled = await setConnectorEnabled("alpha", true, agentDir);
		expect(reenabled.connectors.alpha?.readOnly).toBe(true);
	});

	it("clears the read-only switch without dropping the entry", async () => {
		const agentDir = await tempAgentDir();
		await setConnectorEnabled("alpha", true, agentDir);
		await setConnectorReadOnly("alpha", true, agentDir);
		const cleared = await setConnectorReadOnly("alpha", false, agentDir);

		expect(cleared.connectors.alpha?.enabled).toBe(true);
		expect(cleared.connectors.alpha?.readOnly).toBeUndefined();
		const raw = JSON.parse(await fs.readFile(connectorStatePath(agentDir), "utf8"));
		expect(raw.connectors.alpha).not.toHaveProperty("readOnly");
	});

	it("ignores the switch for a connector that was never enabled", async () => {
		const agentDir = await tempAgentDir();
		expect(await setConnectorReadOnly("ghost", true, agentDir)).toEqual({ version: 1, connectors: {} });
	});
});
