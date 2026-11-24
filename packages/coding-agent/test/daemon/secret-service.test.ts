import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ApprovalBridge, createApprovalBridge, secretRequestPayload } from "../../src/daemon/approval-bridge";
import { SecretService } from "../../src/daemon/services/secret-service";
import { redactMemorySecrets } from "../../src/memory-backend/redact";
import type { AgentSecretUIContext } from "../../src/secrets/agent-store";
import { AgentSecretStore } from "../../src/secrets/agent-store";
import { clearUnlockedMasterKeysForTests } from "../../src/secrets/encrypted-store";

const VALUE = "sk-super-secret-123";
const noop = (): void => {};

function setup(): {
	dir: string;
	store: AgentSecretStore;
	bridge: ApprovalBridge;
	service: SecretService;
} {
	const dir = mkdtempSync(join(tmpdir(), "musepi-secret-service-"));
	const store = new AgentSecretStore(dir);
	const bridge = createApprovalBridge(noop, noop);
	const live = { approvals: bridge };
	const service = new SecretService({
		agentDir: () => dir,
		get: sessionId => (sessionId === "session-1" ? live : undefined),
		allSessions: () => [live][Symbol.iterator](),
	});
	return { dir, store, bridge, service };
}

async function startRequest(
	bridge: ApprovalBridge,
	kind: "fill" | "allow" = "fill",
	workspace?: string,
	delivery: "env" | "file" = "env",
): Promise<{ requestId: string; pending: Promise<{ action: string } | undefined> }> {
	const ui = bridge.uiContext as unknown as AgentSecretUIContext;
	const pending = ui.requestSecret!({
		name: "API_TOKEN",
		purpose: "curl the API",
		kind,
		delivery,
		...(workspace ? { workspace } : {}),
	});
	const requestId = [...bridge.pendingSecrets.keys()][0]!;
	return { requestId, pending };
}

describe("SecretService RPC", () => {
	it("status and list stay empty until a set", async () => {
		const { service } = setup();
		expect(await service.status()).toEqual({
			mode: "encrypted",
			count: 0,
			protectedBy: "key-file",
			locked: false,
		});
		expect(await service.list()).toEqual({ entries: [], count: 0 });
	});

	it("set stores the value and returns metadata only", async () => {
		const { service, store } = setup();
		const result = await service.set({ name: "API_TOKEN", value: VALUE, purpose: "curl the API" });

		expect(result.entry).toMatchObject({ name: "API_TOKEN", purpose: "curl the API", scope: "all" });
		expect(JSON.stringify(result)).not.toContain(VALUE);
		expect(await store.getValue("API_TOKEN")).toBe(VALUE);

		const list = await service.list();
		expect(list.count).toBe(1);
		expect(JSON.stringify(list)).not.toContain(VALUE);
		expect(await service.status()).toEqual({
			mode: "encrypted",
			count: 1,
			protectedBy: "key-file",
			locked: false,
		});
	});

	it("replays a pending secret card to a new subscriber", async () => {
		const { bridge } = setup();
		await startRequest(bridge);
		// The subscribe path serializes `pendingSecrets` with the same payload
		// helper; a reconnecting client must see the still-unanswered card.
		const replay = [...bridge.pendingSecrets.values()].map(secretRequestPayload);
		expect(replay).toEqual([
			{
				requestId: expect.any(String),
				name: "API_TOKEN",
				purpose: "curl the API",
				kind: "fill",
				delivery: "env",
			},
		]);
		expect(JSON.stringify(replay)).not.toContain(VALUE);
	});

	it("answer save persists before settling the tool promise", async () => {
		const { bridge, service, store } = setup();
		const { requestId, pending } = await startRequest(bridge);

		expect(await service.answer({ requestId, action: "save", value: VALUE })).toEqual({ ok: true });
		expect(await pending).toEqual({ action: "save" });
		expect(bridge.pendingSecrets.size).toBe(0);
		expect(await store.getValue("API_TOKEN")).toBe(VALUE);
		expect(JSON.stringify(await service.list())).not.toContain(VALUE);
	});

	it("answer cancel settles without persisting and lands in recent secrets", async () => {
		const { bridge, service, store } = setup();
		const { requestId, pending } = await startRequest(bridge);

		expect(await service.answer({ requestId, action: "cancel" })).toEqual({ ok: true });
		expect(await pending).toEqual({ action: "cancel" });
		expect(await store.list()).toEqual([]);
		expect(bridge.recentResolutions().secrets).toContain(requestId);
	});

	it("answer allow requires an existing value and keeps the request open on failure", async () => {
		const { bridge, service, store } = setup();
		const { requestId, pending } = await startRequest(bridge, "allow");

		await expect(service.answer({ requestId, action: "allow" })).rejects.toThrow(/No stored value/u);
		expect(bridge.pendingSecrets.has(requestId)).toBe(true);

		await store.set("API_TOKEN", VALUE, "curl the API");
		expect(await service.answer({ requestId, action: "allow" })).toEqual({ ok: true });
		expect(await pending).toEqual({ action: "allow" });
	});

	it("rejects a value below the floor without consuming the request", async () => {
		const { bridge, service } = setup();
		const { requestId, pending } = await startRequest(bridge);

		await expect(service.answer({ requestId, action: "save", value: "abc" })).rejects.toThrow(/at least 4/u);
		expect(bridge.pendingSecrets.has(requestId)).toBe(true);
		await service.answer({ requestId, action: "cancel" });
		expect(await pending).toEqual({ action: "cancel" });
	});

	it("a four-character value is accepted now that short values are word-bounded", async () => {
		const { bridge, service, store } = setup();
		const { requestId } = await startRequest(bridge);

		expect(await service.answer({ requestId, action: "save", value: "1234" })).toEqual({ ok: true });
		expect(await store.getValue("API_TOKEN")).toBe("1234");
	});

	it("workspace scope saves only that directory", async () => {
		const { bridge, service, store } = setup();
		const workspace = join(tmpdir(), "musepi-workspace-a");
		const { requestId } = await startRequest(bridge, "fill", workspace);

		expect(await service.answer({ requestId, action: "save", value: VALUE, scope: "workspace" })).toEqual({
			ok: true,
		});
		expect((await store.getEntry("API_TOKEN"))?.scope).toEqual([resolve(workspace)]);
	});

	it("allow extends an existing entry to the asking workspace", async () => {
		const { bridge, service, store } = setup();
		const first = join(tmpdir(), "musepi-workspace-a");
		const second = join(tmpdir(), "musepi-workspace-b");
		await store.set("API_TOKEN", VALUE, "curl the API", [first]);
		const { requestId, pending } = await startRequest(bridge, "allow", second);

		expect(await service.answer({ requestId, action: "allow" })).toEqual({ ok: true });
		expect(await pending).toEqual({ action: "allow" });
		expect((await store.getEntry("API_TOKEN"))?.scope).toEqual(
			expect.arrayContaining([resolve(first), resolve(second)]),
		);
	});

	it("allow without a workspace fails and keeps the request open", async () => {
		const { bridge, service, store } = setup();
		await store.set("API_TOKEN", VALUE, "curl the API", [join(tmpdir(), "musepi-workspace-a")]);
		const { requestId } = await startRequest(bridge, "allow");

		await expect(service.answer({ requestId, action: "allow" })).rejects.toThrow(/no workspace/u);
		expect(bridge.pendingSecrets.has(requestId)).toBe(true);
	});

	it("update widens a narrowed entry to every session", async () => {
		const { service, store } = setup();
		await store.set("API_TOKEN", VALUE, "curl the API", [join(tmpdir(), "musepi-workspace-a")]);

		const result = await service.update({ name: "API_TOKEN", scope: "all" });
		expect(result.entry.scope).toBe("all");
		expect((await store.getEntry("API_TOKEN"))?.scope).toBe("all");
	});

	it("answer save with file delivery writes the private file", async () => {
		const { bridge, service, store } = setup();
		const { requestId } = await startRequest(bridge, "fill", undefined, "file");

		expect(await service.answer({ requestId, action: "save", value: VALUE })).toEqual({ ok: true });
		expect((await store.getEntry("API_TOKEN"))?.delivery).toBe("file");
		expect(await Bun.file(store.filePath("API_TOKEN")).text()).toBe(VALUE);
	});

	it("times out a parked request as cancel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-secret-timeout-"));
		const bridge = createApprovalBridge(noop, noop, noop, noop, { timeoutMs: 10 });
		const ui = bridge.uiContext as unknown as AgentSecretUIContext;
		const pending = ui.requestSecret!({ name: "API_TOKEN", purpose: "curl", kind: "fill" });
		const requestId = [...bridge.pendingSecrets.keys()][0]!;

		expect(await pending).toEqual({ action: "cancel" });
		expect(bridge.pendingSecrets.size).toBe(0);
		expect(bridge.recentResolutions().secrets).toContain(requestId);
		// Nothing was written by the timeout.
		expect(await new AgentSecretStore(dir).list()).toEqual([]);
	});

	it("delete is idempotent", async () => {
		const { service } = setup();
		await service.set({ name: "API_TOKEN", value: VALUE });
		expect(await service.delete({ name: "API_TOKEN" })).toEqual({ ok: true });
		expect(await service.delete({ name: "API_TOKEN" })).toEqual({ ok: true });
		expect(await service.list()).toEqual({ entries: [], count: 0 });
	});

	it("protects, locks and unlocks the store over RPC", async () => {
		const { service } = setup();
		await service.set({ name: "API_TOKEN", value: VALUE });

		expect(await service.encrypt({ passphrase: "correct horse battery" })).toMatchObject({
			protectedBy: "passphrase",
			locked: false,
		});

		clearUnlockedMasterKeysForTests();
		expect(await service.status()).toEqual({
			mode: "encrypted",
			count: 1,
			protectedBy: "passphrase",
			locked: true,
			reason: "missing-passphrase",
		});
		await expect(service.unlock({ passphrase: "not the passphrase" })).rejects.toThrow(/did not unlock/u);
		expect(await service.unlock({ passphrase: "correct horse battery" })).toMatchObject({ locked: false });
		// A session that started while locked had no boundary coverage; the
		// unlock registers every value it just made readable.
		expect(redactMemorySecrets(`token ${VALUE}`)).toContain("[REDACTED]");

		expect(await service.decrypt({ passphrase: "correct horse battery" })).toMatchObject({
			protectedBy: "key-file",
			locked: false,
		});
	});

	it("rephrases the passphrase and keeps the store protected", async () => {
		const { service } = setup();
		await service.set({ name: "API_TOKEN", value: VALUE });
		await service.encrypt({ passphrase: "correct horse battery" });

		await expect(service.rephrase({ current: "not the passphrase", next: "another passphrase" })).rejects.toThrow(
			/did not unlock/u,
		);
		expect(await service.rephrase({ current: "correct horse battery", next: "another passphrase" })).toMatchObject({
			protectedBy: "passphrase",
			locked: false,
		});

		clearUnlockedMasterKeysForTests();
		await expect(service.unlock({ passphrase: "correct horse battery" })).rejects.toThrow(/did not unlock/u);
		expect(await service.unlock({ passphrase: "another passphrase" })).toMatchObject({ locked: false });
	});

	it("unknown request ids and invalid names are refused", async () => {
		const { service } = setup();
		await expect(service.answer({ requestId: "missing", action: "cancel" })).rejects.toThrow(
			/Unknown secret request/u,
		);
		await expect(service.set({ name: "lower", value: VALUE })).rejects.toThrow(/Invalid secret name/u);
	});
});
