/**
 * P2 首刀（ADR 0001）：DaemonHostContext 双跑契约测试。
 *
 * 测试纪律（ADR 边界 3）：全部用真 cordis Context（纯内存、无 IO），不 mock。
 * 钉死的契约：
 *  1. 挂载后 ctx.<key> 解析到与注册表同源的实例（双跑 parity）；
 *  2. 检视面（keys / registrySize）如实；
 *  3. external 生命周期（P2 默认）：挂载不代调 start，dispose 不代调 stop
 *     ——P1 代码是生命周期权威，cordis 拆掉即无损回 P1 形态；
 *  4. cordis 生命周期（opt-in）：start 即 apply、dispose 走 effect 账本
 *     反向回收 stop——框架保证的语义只在显式切换后生效；
 *  5. 重复挂载同 key 抛错；dispose 幂等。
 */
import { describe, expect, it } from "bun:test";
import { DaemonHostContext, mountRegistryServices } from "./host-context";
import type { DaemonService } from "./services/types";

function makeService(key: string, log: string[]): DaemonService {
	return {
		key,
		start() {
			log.push(`${key}.start`);
		},
		stop() {
			log.push(`${key}.stop`);
		},
	};
}

describe("DaemonHostContext (P2 cordis 双跑)", () => {
	it("mounted services resolve on the cordis context as the same instance (dual-run parity)", async () => {
		const host = new DaemonHostContext();
		const svc = makeService("parity", []);
		await host.mount(svc);
		expect(host.get("parity")).toBe(svc);
		await host.dispose();
	});

	it("inspect reports mounted keys and registry size", async () => {
		const host = new DaemonHostContext();
		await host.mount(makeService("a", []));
		await host.mount(makeService("b", []));
		const snapshot = host.inspect();
		expect(snapshot.keys.sort()).toEqual(["a", "b"]);
		expect(snapshot.registrySize).toBe(2);
		await host.dispose();
	});

	it("external lifecycle (P2 default): mount does not call start, dispose does not call stop", async () => {
		const log: string[] = [];
		const host = new DaemonHostContext();
		await host.mount(makeService("external", log));
		expect(log).toEqual([]);
		await host.dispose();
		// Failure mode if regressed: cordis 越权代调 start/stop —— 与 P1 既有
		// 生命周期调用（如 server.ts 的 schedule.start()）双跑副作用。
		expect(log).toEqual([]);
	});

	it("cordis lifecycle (opt-in): start runs at apply, dispose recovers stop via the effect ledger", async () => {
		const log: string[] = [];
		const host = new DaemonHostContext();
		await host.mount(makeService("ledger", log), { lifecycle: "cordis" });
		expect(log).toEqual(["ledger.start"]);
		await host.dispose();
		expect(log).toEqual(["ledger.start", "ledger.stop"]);
	});

	it("duplicate service key is rejected", async () => {
		const host = new DaemonHostContext();
		await host.mount(makeService("dup", []));
		expect(() => host.mount(makeService("dup", []))).toThrow('duplicate service key "dup"');
		await host.dispose();
	});

	it("after dispose the registry path is unaffected (rollback to P1 shape)", async () => {
		const log: string[] = [];
		const svc = makeService("rollback", log);
		const host = new DaemonHostContext();
		await host.mount(svc);
		await host.dispose();
		// cordis 侧已拆：服务解析不到，但实例本身完好（P1 注册表仍持有它）。
		expect(host.get("rollback")).toBeUndefined();
		svc.start?.();
		expect(log).toEqual(["rollback.start"]);
	});

	it("dispose is idempotent", async () => {
		const host = new DaemonHostContext();
		await host.mount(makeService("idem", []));
		await host.dispose();
		await host.dispose();
	});

	it("mountRegistryServices mounts an iterable of services (registry values dual-run)", async () => {
		const host = new DaemonHostContext();
		const services = [makeService("s1", []), makeService("s2", [])];
		const fibers = mountRegistryServices(host, services);
		expect(fibers.length).toBe(2);
		await Promise.all(fibers);
		expect(host.get("s1")).toBe(services[0]);
		expect(host.get("s2")).toBe(services[1]);
		await host.dispose();
	});
});
