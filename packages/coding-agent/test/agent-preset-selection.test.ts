/**
 * dsh-shaped agent preset selection.
 *
 * `agentPreset` is stored in the session header as `modeId` (the field resume
 * readers already use), and selection dispatches `agent-preset/selected` on the
 * session's Cordis bus.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExtensionRuntime, loadExtensionFromFactory } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import { CURRENT_SESSION_VERSION } from "@musepi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

describe("agent preset selection", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@agent-preset-");
	});

	it("persists agentPreset in the session header and clears it", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		// Write the transcript inside the test temp dir. `createEmptySessionFile`
		// targets the production sessions root, which would register this temp
		// cwd as an implicit project in the real workspace registry.
		const id = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const transcript = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: tempDir.path() })}
`,
		);
		const manager = await SessionManager.open(transcript, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});

		manager.setModeId("chat");
		expect(manager.getHeader()?.modeId).toBe("chat");

		const reopened = await SessionManager.open(manager.getSessionFile()!, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		expect(reopened.getHeader()?.modeId).toBe("chat");

		reopened.setModeId(null);
		const cleared = await SessionManager.open(reopened.getSessionFile()!, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		expect(cleared.getHeader()?.modeId).toBeUndefined();
	});

	it("dispatches agent-preset/selected to session listeners", async () => {
		const observed: unknown[] = [];
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				(pi.on as unknown as (name: string, handler: (event: unknown) => void) => () => void)(
					"agent-preset/selected",
					(event: unknown) => {
						observed.push(event);
					},
				);
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			path.join(tempDir.path(), "preset-listener.ts"),
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
		);

		await runner.emitHostEvent("agent-preset/selected", { sessionId: "s1", agentPreset: "chat" });

		expect(observed).toEqual([{ sessionId: "s1", agentPreset: "chat" }]);
		tempDir.removeSync();
	});
});
