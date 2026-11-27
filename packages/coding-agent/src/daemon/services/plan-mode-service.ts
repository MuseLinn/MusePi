/**
 * PlanModeService — the plan-mode RPC seam as an L2 daemon service.
 *
 * Seam:
 * - Services name/inject (dsh parity): key `planMode`. Plan mode is a switch on
 *   the live AgentSession, and its captured state is `sessionMode`'s `plan`
 *   field — the unit is registered here by the service that owns the state, not
 *   by a central list.
 * - Input: `session.setPlan` (toggle + install the proposal handler),
 *   `session.plan` (show/approve/refine/save over the plan file).
 * - Output: `modesOf` snapshots and plan review results; every switch write
 *   publishes the projection so a client never polls.
 * - Lifecycle: stateless between calls except the per-session proposal handler
 *   the AgentSession itself holds; `stop` withdraws the projection unit.
 */

import type { ProjectionDefinition } from "../../session/session-projections";
import { sessionModeProjectionDefinition } from "../../session/session-projections";
import type { SessionProjectionService } from "./session-projection-service";
import type { DaemonService, ServiceStartContext } from "./types";

/** The plan-mode surface of a live session. */
export interface PlanLiveSession {
	agentSession: {
		getPlanModeState(): PlanModeState | undefined;
		setPlanModeState(state: PlanModeState | undefined): void;
		setPlanProposalHandler(handler: ((title: string) => Promise<unknown>) | null): void;
		markPlanReferenceSent(): void;
		getEnabledToolNames(): string[];
		setActiveToolsByName(names: string[]): Promise<void>;
		getAvailableModels(): readonly { id: string; provider?: string }[];
		setModelTemporary(model: unknown): Promise<void>;
		resetSessionContext(): Promise<unknown>;
		compact(instruction?: unknown, options?: Record<string, unknown>): Promise<unknown>;
		setPlanReferencePath(path: string): void;
		isStreaming: boolean;
		prompt(text: string, options?: Record<string, unknown>): Promise<unknown>;
		followUp(text: string, images?: unknown, options?: Record<string, unknown>): Promise<unknown>;
		sessionManager: {
			getCwd(): string;
			getArtifactsDir(): string;
			getSessionId(): string;
		};
	};
}

export interface PlanModeState {
	enabled?: boolean;
	planFilePath?: string;
	title?: string;
}

/** Filesystem/protocol helpers plan mode reads and writes through. */
export interface PlanFilesPort {
	read(planFilePath: string, options: { localProtocolOptions: unknown; cwd: string }): Promise<string | null>;
	list(options: { localProtocolOptions: unknown }): Promise<readonly string[]>;
	write(
		planFilePath: string,
		content: string,
		options: { localProtocolOptions: unknown; cwd: string },
	): Promise<unknown>;
	resolveTitle(input: { planContent: string; planFilePath: string }): { title: string };
	resolveApproved(input: {
		suppliedTitle: string;
		statePlanFilePath?: string;
		readPlan: (url: string) => Promise<string | null>;
		listPlanFiles: () => Promise<readonly string[]>;
	}): Promise<{ planFilePath: string; title: string }>;
}

/** Local-artifact helpers used by the fresh-context approval path. */
export interface PlanLocalPort {
	root(options: unknown): string;
	copy(from: string, to: string): Promise<void>;
	urlToPath(url: string, options: unknown): string;
}

export interface PlanModeServiceDeps {
	get(sessionId: string): PlanLiveSession | undefined;
	publishSessionModeProjection(sessionId: string): void;
	modesOf(session: unknown): unknown;
	files: PlanFilesPort;
	local: PlanLocalPort;
	/** Prompt templates for the approved-plan dispatch and its compact note. */
	renderApprovedPrompt(input: { planFilePath: string; contextPreserved: boolean }): string;
	renderCompactNote(input: { planFilePath: string }): string;
	/** Model resolution for an optional execution-model override. */
	resolveExecutionModel(input: {
		executionModel: { id: string; provider?: string };
		models: readonly { id: string; provider?: string }[];
	}): unknown;
	writeFile(path: string, content: string, encoding: "utf-8"): Promise<void>;
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
	writePlanViaLocal(url: string, content: string, options: unknown): Promise<void>;
}

export class PlanModeService implements DaemonService {
	readonly key = "planMode";
	readonly routes = {
		"session.setPlan": "setPlan",
		"session.plan": "plan",
	} as const;

	readonly #deps: PlanModeServiceDeps;
	#projectionDispose: (() => void) | null = null;

	constructor(deps: PlanModeServiceDeps) {
		this.#deps = deps;
	}

	/** dsh's `static inject`: register this domain's projection unit from the
	 *  host context; a missing dependency fails the mount. */
	start(ctx: ServiceStartContext): void {
		const projections = ctx.get<SessionProjectionService>("sessionProjections");
		if (!projections) throw new Error("planMode: sessionProjections service is not mounted");
		this.#projectionDispose = projections.register(sessionModeProjectionDefinition as ProjectionDefinition<unknown>);
	}

	stop(): void {
		this.#projectionDispose?.();
		this.#projectionDispose = null;
	}

	/** RPC session.setPlan: toggle plan mode and install the proposal handler the
	 *  agent's `propose` path calls when it submits a plan for review. */
	setPlan(params: unknown): unknown {
		const p = (params ?? {}) as { sessionId?: unknown; enabled?: unknown };
		if (typeof p.sessionId !== "string") throw new Error("sessionId required");
		const live = this.#require(p.sessionId);
		const g = live.agentSession;
		const on = typeof p.enabled === "boolean" ? p.enabled : !(g.getPlanModeState()?.enabled === true);
		if (on) {
			g.setPlanModeState({ enabled: true, planFilePath: "" });
			const sessionManager = g.sessionManager;
			const cwd = sessionManager.getCwd();
			const localProtocolOptions = {
				artifactsDir: sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			};
			g.setPlanProposalHandler(async (title: string) => {
				const state = g.getPlanModeState();
				if (!state?.enabled) throw new Error("Plan mode is not active.");
				const { planFilePath, title: resolvedTitle } = await this.#deps.files.resolveApproved({
					suppliedTitle: title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.#deps.files.read(url, { localProtocolOptions, cwd }),
					listPlanFiles: () => this.#deps.files.list({ localProtocolOptions }),
				});
				// Promote the reviewed path so a later approve/refine targets the
				// plan just proposed.
				if (state.planFilePath !== planFilePath) g.setPlanModeState({ ...state, planFilePath });
				return {
					content: [
						{
							type: "text" as const,
							text: `Plan submitted for approval: ${resolvedTitle}. Waiting for the operator to approve or refine it.`,
						},
					],
					details: { planFilePath, title: resolvedTitle, planExists: true },
				};
			});
		} else {
			g.setPlanProposalHandler(null);
			g.setPlanModeState(undefined);
		}
		this.#deps.publishSessionModeProjection(p.sessionId);
		return this.#deps.modesOf(g);
	}

	/** RPC session.plan: plan review lifecycle over the plan file. */
	async plan(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as {
			sessionId?: unknown;
			op?: unknown;
			feedback?: unknown;
			content?: unknown;
			compact?: unknown;
			fresh?: unknown;
			executionModel?: { id: string; provider?: string };
		};
		if (typeof p.sessionId !== "string") throw new Error("sessionId required");
		const live = this.#require(p.sessionId);
		const g = live.agentSession;
		const sessionManager = g.sessionManager;
		const cwd = sessionManager.getCwd();
		const localProtocolOptions = {
			artifactsDir: sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
		const currentPlanPath = async (): Promise<string | undefined> => {
			const state = g.getPlanModeState();
			if (state?.planFilePath) return state.planFilePath;
			return (await this.#deps.files.list({ localProtocolOptions }))[0];
		};
		switch (p.op) {
			case "show": {
				const enabled = g.getPlanModeState()?.enabled === true;
				const planFilePath = enabled ? await currentPlanPath() : undefined;
				if (!enabled || !planFilePath) return { enabled, planFilePath: null, content: null, title: null };
				const read = await this.#deps.files.read(planFilePath, { localProtocolOptions, cwd });
				return {
					enabled,
					planFilePath,
					content: read,
					...this.#deps.files.resolveTitle({ planContent: read ?? "", planFilePath }),
				};
			}
			case "approve": {
				if (!g.getPlanModeState()?.enabled) throw new Error("Plan mode is not active.");
				const planFilePath = await currentPlanPath();
				if (!planFilePath) throw new Error("No plan file to approve.");
				const content = await this.#deps.files.read(planFilePath, { localProtocolOptions, cwd });
				if (content === null) throw new Error(`Plan file not found at ${planFilePath}`);
				const { title } = this.#deps.files.resolveTitle({ planContent: content, planFilePath });
				g.setPlanProposalHandler(null);
				g.setPlanModeState(undefined);
				g.markPlanReferenceSent();
				// Approving leaves plan mode: publish before the long execution path
				// so the badge flips with the click.
				this.#deps.publishSessionModeProjection(p.sessionId);

				// Approved-plan prompts require `read` to load the durable plan file.
				const executionTools = [...new Set([...g.getEnabledToolNames(), "read"])];

				if (p.compact === true) {
					// Pin the reference path before compacting so the approved-prompt
					// injection still finds it afterwards.
					g.setPlanReferencePath(planFilePath);
					await g.compact(undefined, {
						internalGuidance: this.#deps.renderCompactNote({ planFilePath }),
						// Approval hands control back to the user with the execution
						// model armed — it must not auto-resume the aborted turn.
						suppressContinuation: true,
					});
				}
				if (p.fresh === true) {
					// "Clear then execute": drop the planning conversation so the
					// approved prompt runs in a fresh context. Rejects while streaming.
					const oldLocalRoot = this.#deps.local.root(localProtocolOptions);
					const dropped = await g.resetSessionContext();
					if (dropped === undefined) {
						throw new Error("Wait for the current response to finish before approving in a fresh context.");
					}
					const newLocalRoot = this.#deps.local.root(localProtocolOptions);
					await this.#deps.local.copy(oldLocalRoot, newLocalRoot);
					const newPlanPath = this.#deps.local.urlToPath(planFilePath, {
						getArtifactsDir: () => sessionManager.getArtifactsDir(),
						getSessionId: () => sessionManager.getSessionId(),
					});
					await this.#deps.mkdir(parentOf(newPlanPath), { recursive: true });
					await this.#deps.writeFile(newPlanPath, content, "utf-8");
				}

				if (p.executionModel?.id) {
					const model = this.#deps.resolveExecutionModel({
						executionModel: p.executionModel,
						models: g.getAvailableModels(),
					});
					if (!model) throw new Error(`Unknown execution model: ${p.executionModel.id}`);
					await g.setModelTemporary(model);
				}
				await g.setActiveToolsByName(executionTools);

				const contextPreserved = p.fresh !== true;
				const approvePrompt = this.#deps.renderApprovedPrompt({ planFilePath, contextPreserved });
				if (g.isStreaming) {
					await g.followUp(approvePrompt, undefined, { synthetic: true });
				} else {
					try {
						await g.prompt(approvePrompt, { synthetic: true });
					} catch (error) {
						// The streaming check and prompt() race: queue when the turn
						// started in between.
						if (!(error instanceof Error) || error.name !== "AgentBusyError") throw error;
						await g.followUp(approvePrompt, undefined, { synthetic: true });
					}
				}
				return { ok: true, title };
			}
			case "refine": {
				const feedback = (typeof p.feedback === "string" ? p.feedback : "").trim();
				if (!feedback) throw new Error("Refine feedback is empty.");
				await g.followUp(feedback, undefined, { synthetic: true });
				return { ok: true };
			}
			case "save": {
				// In-place plan edit: write the edited content back so the approved
				// plan reflects GUI-side changes.
				const content = (typeof p.content === "string" ? p.content : "").trim();
				if (!content) throw new Error("Plan content is empty.");
				const planFilePath = await currentPlanPath();
				if (!planFilePath) throw new Error("No plan file to save.");
				await this.#deps.files.write(planFilePath, `${content}\n`, { localProtocolOptions, cwd });
				return { ok: true, planFilePath };
			}
			default:
				throw new Error(`session.plan: unknown op ${String(p.op)}`);
		}
	}

	#require(sessionId: string): PlanLiveSession {
		const live = this.#deps.get(sessionId);
		if (!live) throw new Error(`Unknown session: ${sessionId}`);
		return live;
	}
}

/** Minimal POSIX-ish dirname: the plan paths are local artifact paths. */
function parentOf(path: string): string {
	const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return at > 0 ? path.slice(0, at) : ".";
}
