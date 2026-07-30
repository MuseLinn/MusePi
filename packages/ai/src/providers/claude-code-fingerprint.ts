/**
 * Claude Code stealth-fingerprint constants, kept in a leaf module so
 * fingerprint consumers outside the provider (`registry/oauth/anthropic`,
 * `usage/claude`) don't import the heavy `providers/anthropic` module.
 * That import edge was a live init cycle: `providers/anthropic` → `stream` →
 * `registry` → `registry/oauth/anthropic` → back into the still-initializing
 * provider module, which threw a TDZ ReferenceError whenever
 * `providers/anthropic` was the first module loaded.
 */

export const claudeCodeVersion = "2.1.165";
export const claudeAgentSdkVersion = "0.3.165";
export const claudeClientVersion = "1.11187.4";
export const claudeToolPrefix: string = "_";
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
// Claude Code caps requested output at 64k tokens even when the model ceiling is
// higher (e.g. Opus 4.8 supports 128k); OAuth requests clamp to match the wire
// fingerprint. API-key requests keep the full model ceiling.
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
