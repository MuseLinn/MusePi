import { describe, expect, test } from "bun:test";
import { projectDaemonChoice } from "../src/lib/connection/project-instance";
import { type ConnectionTarget, createTarget } from "../src/lib/connection/targets";

/**
 * Which daemon owns a project.
 *
 * A project is a directory on one machine plus a registry entry in one daemon's
 * config. Picking the wrong daemon writes the entry where the path does not
 * exist, and the mistake only surfaces later as a missing folder — so the rule
 * is decided here, once, and a case nobody can serve is reported rather than
 * approximated.
 */

const buildTarget = (row: ConnectionTarget): ConnectionTarget => createTarget({ ...row, url: row.url });

const SSH: ConnectionTarget = buildTarget({
	id: "t-ssh",
	label: "build-box",
	url: "ws://127.0.0.1:9400",
	kind: "ssh",
	sshHost: "me@build",
});
const LOCAL: ConnectionTarget = { id: "local", label: "local", url: "ws://127.0.0.1:8300", kind: "local" };

describe("project daemon", () => {
	test("a local project belongs to the connected daemon", () => {
		expect(projectDaemonChoice({ location: "local", host: "" }, [LOCAL, SSH], "local")).toEqual({ kind: "current" });
	});

	test("a remote project on a stored instance asks the shell to switch there", () => {
		const resolution = projectDaemonChoice({ location: "remote", host: "me@build" }, [LOCAL, SSH], "local");
		expect(resolution.kind).toBe("switch");
		expect(resolution.kind === "switch" && resolution.target.id).toBe("t-ssh");
	});

	test("that instance already being connected makes it current", () => {
		expect(projectDaemonChoice({ location: "remote", host: "me@build" }, [LOCAL, SSH], "t-ssh")).toEqual({
			kind: "current",
		});
	});

	test("a host that is not an instance has no daemon to own the entry", () => {
		// The row would land in whichever registry the shell happens to be on and
		// resolve its root on a machine the user never reached.
		expect(projectDaemonChoice({ location: "remote", host: "me@elsewhere" }, [LOCAL, SSH], "local")).toEqual({
			kind: "unreachable",
			host: "me@elsewhere",
		});
	});

	test("remote without a host is its own answer, not a guess", () => {
		expect(projectDaemonChoice({ location: "remote", host: "   " }, [LOCAL, SSH], "local")).toEqual({
			kind: "missing-host",
		});
	});

	test("a container instance of the same machine is not matched by host alone", () => {
		// Its endpoint is a forwarded container port, not the host's daemon, so
		// matching it by destination would dial the wrong server.
		const container = buildTarget({
			id: "t-docker",
			label: "build container",
			url: "ws://127.0.0.1:9500",
			kind: "docker",
			sshHost: "me@build",
			container: "musepi-dev",
		});
		const resolution = projectDaemonChoice({ location: "remote", host: "me@build" }, [LOCAL, container], "local");
		expect(resolution).toEqual({ kind: "unreachable", host: "me@build" });
	});
});
