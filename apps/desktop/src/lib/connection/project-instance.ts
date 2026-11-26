import type { ConnectionTarget } from "./targets";

/**
 * Which daemon owns a project created at a given location.
 *
 * bitfun binds a workspace to one provider and lets a request whose provider is
 * unavailable **fail** rather than borrow another. The same rule applies here,
 * because a project is two facts in one row: a directory that exists on one
 * machine, and a registry entry that lives in one daemon's config. Creating it
 * on whichever daemon happens to be connected writes the entry where the path
 * does not exist, and the failure surfaces later as "the folder is missing".
 *
 * So the answer is one of three, and never a guess:
 *
 *  - `current`    — the connected daemon already owns it;
 *  - `switch`     — a named instance owns it, and the shell must connect there;
 *  - `unreachable`/`missing-host` — nobody does, and the caller says so.
 *
 * `unreachable` is deliberately distinct from `switch`: a typed host that is not
 * a stored instance has no endpoint to reach, so it cannot own a registry entry
 * at all.
 */
export interface ProjectDaemonChoice {
	location: "local" | "remote";
	host: string;
}

export type ProjectDaemonResolution =
	| { kind: "current" }
	| { kind: "switch"; target: ConnectionTarget }
	| { kind: "unreachable"; host: string }
	| { kind: "missing-host" };

export function projectDaemonChoice(
	choice: ProjectDaemonChoice,
	targets: readonly ConnectionTarget[],
	activeTargetId: string | null,
): ProjectDaemonResolution {
	if (choice.location === "local") return { kind: "current" };
	const host = choice.host.trim();
	if (!host) return { kind: "missing-host" };
	// A container or WSL instance of that host is still that host's daemon, but
	// the dialled endpoint differs; only an ssh row carries the destination the
	// user named, so it is the one that can be matched without guessing.
	const target = targets.find(row => row.kind === "ssh" && row.sshHost === host);
	if (!target) return { kind: "unreachable", host };
	if (target.id === activeTargetId) return { kind: "current" };
	return { kind: "switch", target };
}
