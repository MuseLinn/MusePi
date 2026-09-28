/**
 * CredentialService（M4 P1 凭据托管）契约测试。
 *
 * 安全契约（M4 §4.2/§4.3）：密钥不出 store、不进 wire、不进日志。
 * 钉死的契约：
 *  1. set/list/delete 的 wire 响应只含元数据——深扫序列化结果不含 secret；
 *  2. resolve 返回 secret（daemon 内部消费）且**不在 routes 映射**里；
 *  3. 跨实例持久化（同 storePath 新服务可见）；
 *  4. 校验：空 label/secret、非法 kind 被拒；
 *  5. 损坏的存储文件 fail-soft（回空仓，set 可重建）。
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialService } from "./credential-service";

const dirs: string[] = [];

function newStore(): { service: CredentialService; storePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "musepi-creds-"));
	dirs.push(dir);
	const storePath = join(dir, "credentials.json");
	return { service: new CredentialService({ storePath }), storePath };
}

afterEach(() => {
	dirs.splice(0).forEach(() => {});
});

/** 序列化后深扫 secret 值（wire 安全断言原语）。 */
function containsSecret(value: unknown, secret: string): boolean {
	return JSON.stringify(value).includes(secret);
}

describe("CredentialService (M4 P1 credential store)", () => {
	it("set→list round-trip: wire payloads carry metadata only, never the secret", async () => {
		const { service } = newStore();
		const setResult = await service.set({ label: "Github PAT", kind: "token", secret: "ghp_SECRET_123" });
		expect(containsSecret(setResult, "ghp_SECRET_123")).toBe(false);
		expect(setResult.credential.label).toBe("Github PAT");
		expect(setResult.credential.id).toMatch(/^cred_/);
		expect(setResult.credential.kind).toBe("token");

		const listResult = await service.list();
		expect(listResult.credentials).toHaveLength(1);
		expect(containsSecret(listResult, "ghp_SECRET_123")).toBe(false);
		// Failure mode: secret 混入 wire 响应 → GUI/日志立刻泄漏密钥。
		expect(Object.keys(listResult.credentials[0]).sort()).toEqual(["createdAt", "id", "kind", "label", "updatedAt"]);
	});

	it("resolve returns the secret internally and is NOT reachable via RPC routes", async () => {
		const { service } = newStore();
		const { credential } = await service.set({ label: "x", kind: "env", secret: "s3cr3t-value" });
		expect(await service.resolve(credential.id)).toBe("s3cr3t-value");
		expect(Object.values(service.routes)).not.toContain("resolve");
		// Failure mode: resolve 被挂进 routes → 任何客户端都能 RPC 拉明文密钥。
		expect(Object.keys(service.routes).sort()).toEqual(["credentials.delete", "credentials.list", "credentials.set"]);
	});

	it("persists across service instances sharing the store path", async () => {
		const { service, storePath } = newStore();
		const { credential } = await service.set({ label: "persist", kind: "basic", secret: "pw" });
		const reopened = new CredentialService({ storePath });
		expect((await reopened.list()).credentials.map(c => c.id)).toEqual([credential.id]);
		expect(await reopened.resolve(credential.id)).toBe("pw");
	});

	it("delete removes the record and clears resolution", async () => {
		const { service } = newStore();
		const { credential } = await service.set({ label: "doomed", kind: "token", secret: "x" });
		const result = await service.delete({ id: credential.id });
		expect(result.removed).toBe(true);
		expect((await service.list()).credentials).toHaveLength(0);
		expect(await service.resolve(credential.id)).toBeUndefined();
		expect((await service.delete({ id: credential.id })).removed).toBe(false);
	});

	it("validation rejects empty label/secret and unknown kind", async () => {
		const { service } = newStore();
		await expect(service.set({ label: "", kind: "token", secret: "x" })).rejects.toThrow("label required");
		await expect(service.set({ label: "a", kind: "token", secret: "" })).rejects.toThrow("secret required");
		await expect(service.set({ label: "a", kind: "bogus", secret: "x" })).rejects.toThrow("kind must be one of");
		await expect(service.delete({})).rejects.toThrow("id required");
	});

	it("corrupt store fails soft: empty list, set can rebuild", async () => {
		const { service, storePath } = newStore();
		writeFileSync(storePath, "{not json", { mode: 0o600 });
		expect((await service.list()).credentials).toEqual([]);
		const { credential } = await service.set({ label: "rebuilt", kind: "token", secret: "y" });
		expect((await service.list()).credentials[0].id).toBe(credential.id);
	});
});
