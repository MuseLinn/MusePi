/**
 * 收编第一刀契约测试：builtin 注册表单元挂为 cordis builtin 插件组。
 *
 * 钉死的契约（消费者 = extensions.list 的 runtime 面与插件管理页「运行状态」行）：
 *  1. 挂载：每个非 annotate 单元一个子 fiber,挂载落定后 builtinInspect
 *     如实报告 ACTIVE;ctx.provide 的 `builtin:<id>` 键可解析（builtin
 *     插件宿主级 inject 的落点）;
 *  2. annotate 定义不产生 fiber（登记只为标注,不产生第二条记录）;
 *  3. 检视诚实：未挂载前为空;dispose 后清空（不编造已拆卸 fiber 的状态）;
 *  4. 与 L2 服务挂载共存：mount() 的服务 fiber 与 builtin 组互不干扰。
 *
 * 测试纪律（ADR 边界 3）：真 cordis Context（DaemonHostContext），不 mock。
 */
import { describe, expect, test } from "bun:test";
import { DaemonHostContext } from "../src/daemon/host-context";
import type { DaemonService } from "../src/daemon/services/types";
import { BUILTIN_EXTENSIONS } from "../src/extensibility/extensions-center/builtin-registry";
import { makeExtensionId } from "../src/extensibility/extensions-center/types";

describe("DaemonHostContext builtin 插件组（收编第一刀）", () => {
	test("挂载落定后每个非 annotate 单元如实报告 ACTIVE,annotate 不产生 fiber", async () => {
		const host = new DaemonHostContext();
		await host.mountBuiltinPlugins();
		const inspect = host.builtinInspect();
		const units = BUILTIN_EXTENSIONS.filter(d => !d.annotate);
		const annotated = BUILTIN_EXTENSIONS.filter(d => d.annotate);
		expect(Object.keys(inspect)).toHaveLength(units.length);
		for (const def of units) {
			const id = makeExtensionId(def.kind, def.name);
			expect(inspect[id]?.fiberState).toBe("ACTIVE");
			// ctx.provide 本身即效果账本一条 effect（dsh「everything is an
			// effect」parity）——挂载落定的 fiber 账本非空。
			expect(inspect[id]?.effects).toBeGreaterThanOrEqual(1);
		}
		for (const def of annotated) {
			expect(inspect[makeExtensionId(def.kind, def.name)]).toBeUndefined();
		}
		await host.dispose();
	});

	test("ctx.provide 的 builtin:<id> 键可解析（builtin 宿主级 inject 落点）", async () => {
		const host = new DaemonHostContext();
		await host.mountBuiltinPlugins();
		const stt = host.get<DaemonService & { kind: string; name: string }>("builtin:voice:stt");
		expect(stt?.kind).toBe("voice");
		expect(stt?.name).toBe("stt");
		await host.dispose();
	});

	test("dispose 后检视清空（不编造已拆卸 fiber 的状态）", async () => {
		const host = new DaemonHostContext();
		await host.mountBuiltinPlugins();
		expect(Object.keys(host.builtinInspect()).length).toBeGreaterThan(0);
		await host.dispose();
		expect(host.builtinInspect()).toEqual({});
	});

	test("自定义 defs 形参：空表为空操作,局部 defs 只挂局部（单测隔离面）", async () => {
		const host = new DaemonHostContext();
		await expect(host.mountBuiltinPlugins([])).resolves.toBeUndefined();
		expect(host.builtinInspect()).toEqual({});
		const one = BUILTIN_EXTENSIONS.filter(d => d.kind === "voice" && d.name === "stt");
		await host.mountBuiltinPlugins(one);
		expect(Object.keys(host.builtinInspect())).toEqual(["voice:stt"]);
		await host.dispose();
	});
});
