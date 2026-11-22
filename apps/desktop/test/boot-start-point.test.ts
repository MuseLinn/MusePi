import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { initialBootUrl } from "../src/app";
import {
	loadTargetStatuses,
	recordTargetStatus,
	saveTargetStatuses,
	type TargetStatusMap,
	withoutTargetStatus,
} from "../src/lib/connection/target-store";
import { type ConnectionTarget, createTarget, localTarget, stripToken } from "../src/lib/connection/targets";

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

describe("connection errors never keep a token", () => {
	test("a failed connect to a token-bearing URL stores no token", () => {
		// `RpcClient` rejects with `cannot connect to <url>` where the URL carries
		// the token, and that message was persisted into the status slot — a
		// secret in a second place that even removing the token did not clear.
		localStorage.clear();
		const message = "cannot connect to ws://office.example.com:8300?token=s3cret";
		const scrubbed = stripToken(message);
		expect(scrubbed).toBe("cannot connect to ws://office.example.com:8300");
		expect(scrubbed).not.toContain("s3cret");

		saveTargetStatuses(recordTargetStatus({}, "r1", scrubbed));
		const stored = JSON.stringify(loadTargetStatuses());
		expect(stored).not.toContain("s3cret");
	});

	test("clearing the token clears the row's stored error", () => {
		localStorage.clear();
		saveTargetStatuses({ r1: { lastAttemptAt: 1_700_000_000_000, lastError: "cannot connect" } });
		// The rule `addTarget` applies when a row's token changes.
		const next = withoutTargetStatus(loadTargetStatuses(), "r1");
		saveTargetStatuses(next);
		expect(loadTargetStatuses().r1).toBeUndefined();
		// A map with no such row is returned untouched, so the caller can skip a
		// pointless write.
		expect(withoutTargetStatus(next, "r1")).toBe(next);
	});
});
