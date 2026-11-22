import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { initialBootUrl } from "../src/app";
import { runBootAttempt } from "../src/lib/connection/boot-attempt";
import {
	loadTargetStatuses,
	saveTargetStatuses,
	settledStatuses,
	statusesAfterTargetEdit,
	type TargetStatusMap,
} from "../src/lib/connection/target-store";
import { type ConnectionTarget, createTarget, localTarget } from "../src/lib/connection/targets";

/**
 * The launch's start point.
 *
 * Nothing covered `INITIAL_URL`, which is why 98 green tests missed a remote
 * target losing its token on restart and a local fallback re-dialling the row it
 * was meant to replace. The expression is pure over the stored facts, so it is
 * asserted directly rather than through a mounted shell.
 */

const DEFAULT = "ws://127.0.0.1:8300";

const remote = (token?: string): ConnectionTarget =>
	createTarget({
		id: "r1",
		label: "Office",
		url: "ws://office.example.com:8300",
		kind: "manual",
		token,
	});

const forwarded = (): ConnectionTarget =>
	createTarget({
		id: "s1",
		label: "Build box",
		url: "ws://127.0.0.1:9400",
		kind: "ssh",
		sshHost: "me@build.example.com",
		remotePort: 8300,
	});

describe("initial boot url", () => {
	test("a local kind starts at the local daemon", () => {
		const url = initialBootUrl({
			storedUrl: "ws://127.0.0.1:8300",
			targets: [localTarget()],
			chosenId: "local",
			statuses: {},
			defaultUrl: DEFAULT,
		});
		expect(url).toBe(DEFAULT);
	});

	test("a remote row keeps its token", () => {
		// The row stores its endpoint without the secret; booting from that alone
		// made a --remote-token instance answer 401 on the next launch.
		const url = initialBootUrl({
			storedUrl: "ws://office.example.com:8300",
			targets: [localTarget(), remote("s3cret")],
			chosenId: "r1",
			statuses: {},
			defaultUrl: DEFAULT,
		});
		expect(url).toBe("ws://office.example.com:8300?token=s3cret");
		expect(url).toContain("token=");
	});

	test("a failed forwarded row falls back to the local daemon, not the stored endpoint", () => {
		// `bootTargetFor` refuses the silent forwarded row; returning the stored
		// URL here would re-dial exactly that row, undoing the fallback.
		const statuses: TargetStatusMap = { s1: { lastAttemptAt: 1_700_000_000_000, lastError: "timeout" } };
		const url = initialBootUrl({
			storedUrl: "ws://127.0.0.1:9400",
			targets: [localTarget(), forwarded()],
			chosenId: "s1",
			statuses,
			defaultUrl: DEFAULT,
		});
		expect(url).toBe(DEFAULT);
		expect(url).not.toContain("9400");
	});

	test("nothing stored means the default", () => {
		expect(
			initialBootUrl({
				storedUrl: null,
				targets: [localTarget(), remote("s3cret")],
				chosenId: "r1",
				statuses: {},
				defaultUrl: DEFAULT,
			}),
		).toBe(DEFAULT);
	});
});

/**
 * The token never reaches the status slot, through the real writers.
 *
 * These go through `settledStatuses` and `statusesAfterTargetEdit` — the
 * functions `recordBootOutcome`, `attribute` and `addTarget` call — rather than
 * computing the scrub in the test body, so deleting the production call turns
 * them red instead of leaving a pin that always passes.
 */

const TOKEN_URL = "ws://office.example.com:8300?token=s3cret";

describe("the status slot never keeps a token", () => {
	test("a boot-path failure with a token-bearing message stores no token", () => {
		localStorage.clear();
		// What boot actually composes: `runBootAttempt` settles a throw reason,
		// and `recordBootOutcome` writes it through `settledStatuses`.
		const settle = async (): Promise<void> => {
			throw new Error(`cannot connect to ${TOKEN_URL}`);
		};
		return runBootAttempt(settle, { at: "ws://127.0.0.1:8300", reason: "无法连接本地守护进程" }).then(outcome => {
			expect(outcome.ok).toBe(false);
			expect(outcome.reason).toContain("token=s3cret");
			// The composition boot applies to that reason:
			const next = settledStatuses({}, "r1", outcome.ok, outcome.reason);
			saveTargetStatuses(next);
			expect(JSON.stringify(loadTargetStatuses())).not.toContain("s3cret");
			expect(next.r1?.lastError).toBe("cannot connect to ws://office.example.com:8300");
		});
	});

	test("an ordinary cold-start failure stores no token either", () => {
		localStorage.clear();
		// The non-throwing exit: `recordBootOutcome` reads the captured error.
		const next = settledStatuses({}, "r1", false, `cannot connect to ${TOKEN_URL}`);
		saveTargetStatuses(next);
		expect(JSON.stringify(loadTargetStatuses())).not.toContain("s3cret");
	});

	test("a status slot written by an older build is scrubbed when it is loaded", () => {
		localStorage.clear();
		// Simulate the pre-fix slot, then read it through the loader.
		localStorage.setItem(
			"musepi-gui-target-status",
			JSON.stringify({ r1: { lastAttemptAt: 1_700_000_000_000, lastError: `cannot connect to ${TOKEN_URL}` } }),
		);
		expect(JSON.stringify(loadTargetStatuses())).not.toContain("s3cret");
		// And the scrubbed copy replaced it on disk, so it does not linger.
		expect(localStorage.getItem("musepi-gui-target-status") ?? "").not.toContain("s3cret");
	});

	test("changing a row's token drops that row's stored error", () => {
		const previous = remote("old-token");
		const edited = remote("new-token");
		const statuses: TargetStatusMap = { r1: { lastAttemptAt: 1_700_000_000_000, lastError: "cannot connect" } };
		const next = statusesAfterTargetEdit(statuses, previous, edited);
		expect(next.r1).toBeUndefined();
	});

	test("removing a row's token drops that row's stored error", () => {
		const previous = remote("s3cret");
		const cleared = remote(undefined);
		const statuses: TargetStatusMap = { r1: { lastAttemptAt: 1_700_000_000_000, lastError: "cannot connect" } };
		expect(statusesAfterTargetEdit(statuses, previous, cleared).r1).toBeUndefined();
	});

	test("an unchanged token keeps the row's stored error", () => {
		const previous = remote("s3cret");
		const edited = remote("s3cret");
		const statuses: TargetStatusMap = { r1: { lastAttemptAt: 1_700_000_000_000, lastError: "cannot connect" } };
		expect(statusesAfterTargetEdit(statuses, previous, edited)).toBe(statuses);
	});
});
