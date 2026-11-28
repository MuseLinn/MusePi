import { describe, expect, it } from "bun:test";
import type { Settings } from "../config/settings";
import { DEFAULT_APPROVAL_MODE, resolveApprovalMode, resolveApprovalPolicies } from "./approval-mode";

function settings(values: Record<string, unknown>): Pick<Settings, "get"> {
	return { get: (key: string) => values[key] } as unknown as Pick<Settings, "get">;
}

describe("resolveApprovalMode", () => {
	it("falls back to the module default when settings never chose a mode", () => {
		// Every call site used to spell `?? "yolo"` itself; the default now has
		// one definition, so a future change cannot reach some sites and miss others.
		const resolved = resolveApprovalMode(settings({}));
		expect(resolved.mode).toBe(DEFAULT_APPROVAL_MODE);
		expect(resolved.source).toBe("global");
	});

	it("reads the configured mode from settings", () => {
		expect(resolveApprovalMode(settings({ "tools.approvalMode": "always-ask" }))).toEqual({
			mode: "always-ask",
			source: "global",
		});
	});

	it("lets auto-approve outrank every layered selection", () => {
		// `--auto-approve` is a session-wide grant; a narrower layer must not
		// silently take it back and start prompting an unattended run.
		const resolved = resolveApprovalMode(settings({ "tools.approvalMode": "always-ask" }), {
			autoApprove: true,
			turn: "always-ask",
			session: "always-ask",
			identity: "always-ask",
		});
		expect(resolved).toEqual({ mode: "yolo", source: "auto-approve" });
	});

	it("prefers the most specific layer and names it", () => {
		const base = {
			global: undefined,
			identity: "write" as const,
			session: "always-ask" as const,
			turn: "yolo" as const,
		};
		expect(
			resolveApprovalMode(settings({}), { turn: base.turn, session: base.session, identity: base.identity }),
		).toEqual({
			mode: "yolo",
			source: "turn",
		});
		expect(resolveApprovalMode(settings({}), { session: base.session, identity: base.identity })).toEqual({
			mode: "always-ask",
			source: "session",
		});
		expect(resolveApprovalMode(settings({}), { identity: base.identity })).toEqual({
			mode: "write",
			source: "identity",
		});
	});

	it("keeps the identity layer authoritative over the global setting", () => {
		// A bot lane's own preset must win over the profile default, which is
		// what makes a persistent-assistant identity readable at all.
		const resolved = resolveApprovalMode(settings({ "tools.approvalMode": "yolo" }), { identity: "always-ask" });
		expect(resolved).toEqual({ mode: "always-ask", source: "identity" });
	});

	it("treats an absent auto-approve flag as no grant", () => {
		expect(resolveApprovalMode(settings({ "tools.approvalMode": "write" }), { autoApprove: false })).toEqual({
			mode: "write",
			source: "global",
		});
	});
});

describe("resolveApprovalPolicies", () => {
	it("returns the configured per-tool policies", () => {
		const policies = { bash: "deny", read: "allow" };
		expect(resolveApprovalPolicies(settings({ "tools.approval": policies }))).toEqual(policies);
	});

	it("returns an empty policy set when none is configured", () => {
		expect(resolveApprovalPolicies(settings({}))).toEqual({});
	});
});
