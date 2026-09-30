import { describe, expect, it } from "bun:test";
import type { BatchedEvent } from "../../src/daemon/event-batcher";
import { EventService } from "../../src/daemon/services/event-service";

/**
 * P0-1：全局事件与会话 journal 记录的 kind 分离契约。
 *
 * 失败模式：全局广播若以 kind:"event" 下发（全局 seq 是独立于任何会话
 * journal 的计数空间），客户端 session-store 的水位门会把它当作该会话的
 * journal 记录——seq 恰好接上水位时后续真实记录被误判「重放」静默丢弃，
 * seq 越过水位+1 时触发无意义的 catchup/resync 风暴（STT/TTS 下载进度
 * 广播可把整会话反复打回重订阅）。
 */

function makeService() {
	const emitted: BatchedEvent[] = [];
	const service = new EventService({
		emitEvent: (_conn, event) => {
			emitted.push(event);
		},
		catchupFrom: () => Promise.resolve({ ok: true }),
	});
	service.subscribe({ id: "c1" });
	return { service, emitted };
}

describe("EventService global-event kind separation (P0-1)", () => {
	it("broadcast() emits kind 'global-event', never the journal kind 'event'", () => {
		const { service, emitted } = makeService();
		service.broadcastExtensionsChanged();
		service.broadcastModelsChanged();
		service.broadcastCronsChanged();
		expect(emitted).toHaveLength(3);
		for (const envelope of emitted) {
			expect(envelope.kind).toBe("global-event");
			expect(envelope.sessionId).toBeUndefined();
			// 帧识别要求数字 seq（rpc.ts 按 typeof seq === "number" 判定
			// 订阅信封）——seq 保留但不再进任何会话水位语义。
			expect(typeof envelope.seq).toBe("number");
			expect((envelope.seq as number) > 0).toBe(true);
		}
		// 独立计数空间仍然递增（保序/去重依据），只是不再与 journal 共享 kind。
		const seqs = emitted.map(e => e.seq as number);
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("broadcastExtensionNotification() rides the same 'global-event' kind", () => {
		const { service, emitted } = makeService();
		service.broadcastExtensionNotification("test-channel", { text: "hello", kind: "info" });
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe("global-event");
		expect(emitted[0]?.sessionId).toBeUndefined();
	});
});
