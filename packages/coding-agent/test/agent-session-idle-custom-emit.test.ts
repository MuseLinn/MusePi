/**
 * Contract: an idle `sendCustomMessage` (no turn started) persists exactly
 * once AND notifies live subscribers.
 *
 * Failure mode: the idle branches appended to the agent context and the
 * session file but emitted nothing — journal / materialized view / GUI
 * never learned the row existed until the next resume. A transcript card
 * (advisor note, IRC aside, tool-registry line) therefore existed on disk
 * and in front of the model while every event-driven surface stayed
 * silent. The fix emits message_start/end (the #preserveAdvisorCard
 * shape) with a non-enumerable skip-persist mark so the event-driven
 * #persistMessageEnd does not write a second file copy.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@musepi/pi-utils";

const ADVISOR_TYPE = "advisor";

function advisorCard(content: string) {
	return {
		customType: ADVISOR_TYPE,
		content,
		display: true,
		attribution: "agent" as const,
		details: { notes: [{ note: content, severity: "nit" as const }] },
	};
}

describe("AgentSession idle custom-message emit", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-idle-custom-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await Bun.sleep(0);
			await tempDir?.remove();
		}
	});

	async function createIdleSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: [] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		return session;
	}

	it("emits start/end to subscribers and persists exactly once", async () => {
		const s = await createIdleSession();
		const seen: { type: string; message: AgentMessage }[] = [];
		const unsub = s.subscribe(e => {
			if (e.type === "message_start" || e.type === "message_end") {
				seen.push({
					type: e.type,
					message: (e as { message: AgentMessage }).message,
				});
			}
		});
		try {
			const started = await s.sendCustomMessage(advisorCard("idle nit"), {});
			expect(started).toBe(false);
			// Flush the async subscriber fan-out.
			await Bun.sleep(0);
			const frames = seen.filter(f => (f.message as { customType?: string }).customType === ADVISOR_TYPE);
			expect(frames.map(f => f.type)).toEqual(["message_start", "message_end"]);
			const end = frames[1]!.message as {
				display?: boolean;
				details?: { notes?: { note?: string }[] };
			};
			expect(end.display).toBe(true);
			expect(end.details?.notes?.[0]?.note).toBe("idle nit");
			// Exactly one file copy: the direct idle persist stands, the
			// event-driven persist skips via the non-enumerable mark.
			const cards = s.sessionManager
				.getEntries()
				.filter(e => e.type === "custom_message" && (e as { customType?: string }).customType === ADVISOR_TYPE);
			expect(cards).toHaveLength(1);
			// The mark never leaks into serialized payloads.
			expect(JSON.stringify(frames[1]!.message)).not.toContain("skipPersist");
		} finally {
			unsub();
		}
	});

	it("nextTurn-append without trigger also emits instead of staying silent", async () => {
		const s = await createIdleSession();
		const seen: string[] = [];
		const unsub = s.subscribe(e => {
			if (e.type === "message_start" || e.type === "message_end") seen.push(e.type);
		});
		try {
			const started = await s.sendCustomMessage(advisorCard("parked note"), {
				deliverAs: "nextTurn",
				triggerTurn: false,
			});
			expect(started).toBe(false);
			await Bun.sleep(0);
			expect(seen).toEqual(["message_start", "message_end"]);
			const cards = s.sessionManager
				.getEntries()
				.filter(e => e.type === "custom_message" && (e as { customType?: string }).customType === ADVISOR_TYPE);
			expect(cards).toHaveLength(1);
		} finally {
			unsub();
		}
	});
});
