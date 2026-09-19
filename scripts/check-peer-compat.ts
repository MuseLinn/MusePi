#!/usr/bin/env bun

/**
 * Guards against peer-dependency version drift that blanks the renderer.
 *
 * Why this exists: e5ba4de17 added `react-konva` to desktop-app as a caret
 * range (`^19.3.0`) while `react`/`react-dom` are pinned to an exact 19.2.7.
 * react-konva@19.3.0 throws at module-eval time when the host React is older
 * than 19.3, so the failure is not a missing feature — the entire bundle dies
 * before `createRoot().render()` runs and the window renders completely blank
 * (prod build and vite dev alike). Nothing in the existing gates noticed:
 * a version mismatch between two installed packages is invisible to tsgo
 * (the types still resolve) and to biome.
 *
 * This check is offline and deterministic on purpose — it inspects the
 * installed tree, not the network, so it can run in CI as a hard gate.
 *
 * Usage:
 *   bun scripts/check-peer-compat.ts          # check (exit 1 on violation)
 *   bun scripts/check-peer-compat.ts --list   # print the rules and exit
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");

/**
 * Packages whose runtime version check has bitten us, mapped to the package
 * that imposes the constraint and a human explanation for the failure mode.
 * Add a rule here whenever a dependency performs its own hard version guard.
 */
interface PeerRule {
	/** Package that performs the runtime version check. */
	subject: string;
	/** Package whose installed version the subject constrains. */
	peer: string;
	/** Workspace dir (relative to repo root) that consumes the subject. */
	workspace: string;
	/** Why a mismatch matters — surfaced verbatim on failure. */
	why: string;
}

const RULES: PeerRule[] = [
	{
		subject: "react-konva",
		peer: "react",
		workspace: "packages/desktop-app",
		why: "react-konva throws 'requires React 19.3 or later' at module-eval, which kills the whole renderer bundle before React mounts (blank window).",
	},
];

function readVersion(pkgDir: string, name: string): string | null {
	const manifest = path.join(pkgDir, "node_modules", name, "package.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string };
		return parsed.version ?? null;
	} catch {
		return null;
	}
}

/** Parse a version into numeric segments; ignores prerelease/build metadata. */
function segments(version: string): number[] {
	return version
		.split("-")[0]
		.split(".")
		.map(part => Number.parseInt(part, 10))
		.map(n => (Number.isFinite(n) ? n : 0));
}

/** Compare dotted versions numerically: -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
	const left = segments(a);
	const right = segments(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Does `version` satisfy a caret range (the only range form we declare for
 * these runtime-guarded peers)? Caret means "same leftmost non-zero segment":
 * ^19.3.0 admits >=19.3.0 <20.0.0.
 */
export function satisfiesCaret(version: string, range: string): boolean {
	const floor = range.replace(/^[\^~]/, "");
	if (compareVersions(version, floor) < 0) return false;
	const [major] = segments(floor);
	if (major > 0) return segments(version)[0] === major;
	// ^0.x semantics — not used by current rules, but keep it honest.
	const minor = segments(floor)[1] ?? 0;
	return segments(version)[0] === 0 && (segments(version)[1] ?? 0) === minor;
}

interface Violation {
	rule: PeerRule;
	subjectVersion: string;
	peerVersion: string;
}

export function checkRules(root = REPO_ROOT): Violation[] {
	const violations: Violation[] = [];
	for (const rule of RULES) {
		const workspaceDir = path.join(root, rule.workspace);
		const subjectVersion = readVersion(workspaceDir, rule.subject) ?? readVersion(root, rule.subject);
		const peerVersion = readVersion(workspaceDir, rule.peer) ?? readVersion(root, rule.peer);
		// Only meaningful when both are actually installed in this tree.
		if (!subjectVersion || !peerVersion) continue;
		if (compareVersions(subjectVersion, peerVersion) > 0) {
			violations.push({ rule, subjectVersion, peerVersion });
		}
	}
	return violations;
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.includes("--list")) {
		for (const rule of RULES) {
			console.log(`${rule.workspace}: ${rule.subject} must not be newer than ${rule.peer}`);
			console.log(`  ${rule.why}`);
		}
		return;
	}

	const violations = checkRules();
	if (violations.length === 0) {
		console.log(`check-peer-compat: OK — ${RULES.length} rule(s) satisfied.`);
		return;
	}

	console.error("check-peer-compat: FAILED — a runtime-guarded peer is newer than its host peer.\n");
	for (const { rule, subjectVersion, peerVersion } of violations) {
		console.error(`  ${rule.workspace}`);
		console.error(`    ${rule.subject}@${subjectVersion}  >  ${rule.peer}@${peerVersion}`);
		console.error(`    ${rule.why}`);
		console.error(
			`    Fix: pin ${rule.subject} to a version whose peer range admits ${rule.peer}@${peerVersion},\n` +
				`         or raise ${rule.peer} to match. Do NOT widen to a caret range.\n`,
		);
	}
	process.exit(1);
}

if (import.meta.main) main();
