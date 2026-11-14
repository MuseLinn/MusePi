const EXTERNAL_AGENT_BINARIES: Readonly<Record<string, string>> = {
	"subagent-codex": "codex",
	"subagent-claude-code": "claude",
	"subagent-codebuddy": "codebuddy",
	"subagent-kimi-code": "kimi",
	"subagent-opencode": "opencode",
};

export type ExternalExecutableProbeResult =
	| { available: true; path: string; version: string }
	| { available: false; reason: "not-found" | "failed"; path?: string; error?: string };

export type ExternalEnvironmentIssue = "invalid-json" | "not-object" | "non-string-values";

export function externalAgentBinary(name: string): string | undefined {
	return EXTERNAL_AGENT_BINARIES[name.startsWith("musepi-") ? name.slice("musepi-".length) : name];
}

export function externalEnvironmentIssue(value: string): ExternalEnvironmentIssue | null {
	if (!value.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return "invalid-json";
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not-object";
	return Object.values(parsed).some(entry => typeof entry !== "string") ? "non-string-values" : null;
}
