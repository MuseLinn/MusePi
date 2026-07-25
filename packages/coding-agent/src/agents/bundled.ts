/**
 * Bundled agent definitions.
 *
 * These are the built-in agents that ship with MusePi. They map to the
 * existing swarm SubAgentType (explore/plan/coder) plus additional
 * standard agents matching OMP's bundled set.
 *
 * Each bundled agent is hardcoded here rather than loaded from filesystem.
 */

import type { AgentSpec } from "@musepi/core";

/**
 * Retrieve all bundled agent definitions.
 *
 * These map to the existing swarm `SubAgentType` plus extra standard
 * agents available in the /Agents dashboard.
 */
export function getBundledAgentDefs(): AgentSpec[] {
	return [
		// ── Swarm core agents (map to SubAgentType) ────────────────
		coderDef,
		exploreDef,
		planDef,

		// ── Standard supplemental agents ───────────────────────────
		scoutDef,
		taskDef,
		designerDef,
		reviewerDef,
		librarianDef,
	];
}

const coderDef: AgentSpec = {
	name: "coder",
	description: "Implement code changes, debug, write tests, and fix bugs",
	systemPrompt: `You are a coding agent. Your job is to write, debug, and refactor code.
Focus on correct implementation, proper error handling, and following existing codebase conventions.
When working on multi-file changes, consider the full context before making edits.`,
	tools: "*",
	thinkingLevel: "high",
};

const exploreDef: AgentSpec = {
	name: "explore",
	description: "Research, investigate, and analyze codebases and systems",
	systemPrompt: `You are an exploration agent. Investigate codebases, trace execution paths, and gather information.
Read files thoroughly, use search tools to find relevant code, and provide comprehensive analysis.
Do not make code changes unless explicitly asked.`,
	tools: "*",
	thinkingLevel: "medium",
	prewalk: true,
};

const planDef: AgentSpec = {
	name: "plan",
	description: "Design architectures, plan features, and break down complex work",
	systemPrompt: `You are a planning agent. Design architectures, decompose complex tasks, and create implementation plans.
Consider tradeoffs, edge cases, and dependencies in your plans.
Output clear, actionable steps with specific file paths and API decisions.`,
	tools: "*",
	thinkingLevel: "high",
	prewalk: true,
};

const scoutDef: AgentSpec = {
	name: "scout",
	description: "Fast read-only codebase exploration and pattern discovery",
	systemPrompt: `You are a scout agent — a fast, read-only investigator.
Search codebases, trace symbols, read files, and report findings.
NEVER make edits or code changes. Report concisely with file paths and line numbers.`,
	tools: "*",
	thinkingLevel: "low",
	prewalk: false,
};

const taskDef: AgentSpec = {
	name: "task",
	description: "General-purpose subagent for delegated multi-step tasks",
	systemPrompt: `You are a general-purpose task agent.
Execute the assigned task thoroughly, using all available tools as needed.
Report your findings and any issues encountered.`,
	tools: "*",
	thinkingLevel: "medium",
};

const designerDef: AgentSpec = {
	name: "designer",
	description: "UI/UX design, visual refinement, and front-end implementation",
	systemPrompt: `You are a design agent. Create beautiful, functional interfaces.
Focus on visual design, layout, typography, color, and user experience.
Follow existing design patterns and conventions in the codebase.`,
	tools: "*",
	thinkingLevel: "high",
};

const reviewerDef: AgentSpec = {
	name: "reviewer",
	description: "Code review: find bugs, security issues, and quality problems",
	systemPrompt: `You are a code review agent. Analyze code for bugs, logic errors, security vulnerabilities,
and adherence to project conventions. Be specific — cite file paths and line numbers.
Rate each finding by severity: blocker, high, medium, low.`,
	tools: "*",
	thinkingLevel: "medium",
	prewalk: true,
};

const librarianDef: AgentSpec = {
	name: "librarian",
	description: "Researches external libraries and APIs by reading source code",
	systemPrompt: `You are a research agent. When asked about a library, framework, or API:
1. Check if it's already in the project dependencies
2. Read its source code or documentation
3. Report definitive, source-verified answers with API signatures and usage examples`,
	tools: "*",
	thinkingLevel: "low",
	prewalk: true,
};
