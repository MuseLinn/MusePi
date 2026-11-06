import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { JobLedger } from "@musepi/pi-coding-agent/async/job-ledger";
import { TempDir } from "@musepi/pi-utils";

describe("JobLedger", () => {
	it("marks a running job lost after a restart", () => {
		using tempDir = TempDir.createSync("@omp-job-ledger-");
		const file = path.join(tempDir.path(), "jobs.db");
		const first = new JobLedger(file);
		first.register({
			id: "job-1",
			sessionId: "session-1",
			type: "bash",
			label: "bun test",
			startTime: Date.now(),
		});
		first.close();

		const second = new JobLedger(file);
		const lost = second.recoverRunning();
		expect(lost).toHaveLength(1);
		expect(lost[0]).toMatchObject({ id: "job-1", sessionId: "session-1", status: "lost" });
		expect(second.listLostForSession("session-1")).toHaveLength(1);
		second.close();
	});

	it("does not mark a finished job lost", () => {
		using tempDir = TempDir.createSync("@omp-job-ledger-");
		const file = path.join(tempDir.path(), "jobs.db");
		const first = new JobLedger(file);
		first.register({
			id: "job-2",
			sessionId: "session-1",
			type: "task",
			label: "explore",
			startTime: Date.now(),
		});
		first.finish("job-2", "completed", "done");
		first.markDelivered("job-2");
		first.close();

		const second = new JobLedger(file);
		expect(second.recoverRunning()).toHaveLength(0);
		second.close();
	});
});
