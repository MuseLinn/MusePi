import { getPuppeteerDir, logger, postmortem, Snowflake, withTimeout, workerHostEntry } from "@musepi/pi-utils";
import type { CDPSession, Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "../../utils/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError } from "../tool-errors";
import { agentCdpParams, type BrowserAgentIdentity, isUnknownCdpMethodError } from "./agent-identity";
import { pickElectronTarget, shouldPreserveConnectedBrowserFocus } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { DEFAULT_VIEWPORT } from "./launch";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "./registry";
import type {
	BrowserOperation,
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	SessionSnapshot,
	Transferable,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "./tab-protocol";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.

interface WorkerHandle {
	send(msg: WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker" | "inline";
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	onOperations?: (operations: BrowserOperation[]) => void;
	/**
	 * Fires when `releaseTab` closes the tab out from under an in-flight run
	 * (sibling `browser close --all`, session-scoped reap, etc.). Composed
	 * into the cmux run's signal so `wait(...)`, cmux socket calls, and the
	 * facade proxies unwind promptly instead of blocking to the run's
	 * timeout. `pending.reject` still fires first so the awaiting caller
	 * sees the tab-close error immediately; `closeAc` propagates the
	 * cancellation into the still-running `runCmuxCode` body (issue #4499).
	 */
	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
	/**
	 * Agent registry id ({@link ToolSession.getAgentId}) of the caller that
	 * CREATED the tab. A subagent disposes independently of its parent while
	 * both share one session id, so session-scoped ownership alone would let
	 * the child's teardown close tabs the parent (or the user) is still using.
	 * Recorded on creation only, like {@link ownerSessionId}.
	 */
	ownerAgentId?: string;
	/** Display name for {@link ownerAgentId}, when the registry knows one. */
	ownerAgentName?: string;
	/**
	 * Agent that inherits this tab when {@link ownerAgentId} releases it — the
	 * spawning agent for a subagent. `releaseTabsForOwner` hands the tab over
	 * instead of closing it, so a finished child never shuts a tab the parent
	 * can still drive.
	 */
	parentAgentId?: string;
	/** Display name for {@link parentAgentId}. */
	parentAgentName?: string;
	/**
	 * Session id that reaps this tab after a hand-off. Equal to
	 * {@link ownerSessionId} unless the subagent minted its own session id, in
	 * which case the parent's live session id takes over.
	 */
	parentSessionId?: string;
	/**
	 * Agent whose run most recently held this tab. Set while a run is in
	 * flight so a concurrent run's rejection can name the operator.
	 */
	activeAgentId?: string;
	activeAgentName?: string;
	/**
	 * Panel tab this open CREATED through standard CDP `Target.createTarget` on
	 * the managed browser (a shell that predates `ManagedBrowser.ensureAgentTab`
	 * has no dedicated agent tab to reuse). The supervisor owns its lifetime and
	 * closes it on release so version skew does not accumulate panel tabs.
	 */
	createdTargetId?: string;
	/**
	 * This tab drives the managed browser's DEDICATED agent tab, so the panel
	 * badge can be republished when the operator changes (hand-off, a run by a
	 * different agent) without creating or adopting another page.
	 */
	managedAgentTab?: boolean;
	/** Agent last published as this tab's operator on the managed panel. */
	publishedAgentId?: string;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
	activateForScreenshot: boolean;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
	/**
	 * Agent registry id of the acquirer. Recorded on creation only. Two
	 * different agents never reuse the same tab name, so a subagent cannot
	 * hijack a parent's tab (or vice versa) by picking the same name.
	 */
	agentId?: string;
	/** Display name of {@link agentId} for the GUI operator badge. */
	agentName?: string;
	/** Agent that inherits the tab when {@link agentId} releases it. */
	parentAgentId?: string;
	/** Display name of {@link parentAgentId}. */
	parentAgentName?: string;
	/**
	 * Session id of {@link parentAgentId}'s session, when the registry has a
	 * live entry. A subagent's in-memory transcript can mint its own session id,
	 * in which case the hand-off must also move the reap key to the parent or
	 * the tab outlives every session that could release it.
	 */
	parentSessionId?: string;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
	/** Agent driving the run; recorded while it is in flight. */
	agentId?: string;
	agentName?: string;
	onOperations?: (operations: BrowserOperation[]) => void;
}

export interface ReleaseTabOptions {
	kill?: boolean;
	/** Maximum time for each asynchronous cleanup resource before close fails with diagnostics. */
	timeoutMs?: number;
}

export interface ReleaseTabsForOwnerOptions extends ReleaseTabOptions {
	/**
	 * Scope the reap to tabs CREATED by this agent. Subagents share their
	 * parent's session id but not its agent id, so this is what keeps a
	 * finished child from tearing down tabs the parent still drives.
	 */
	agentId?: string;
	/**
	 * Agent that inherits the scoped tabs instead of seeing them closed — the
	 * spawning agent for a subagent. Without it the scoped tabs close, which is
	 * the pre-existing behavior for a top-level session.
	 */
	fallbackAgentId?: string;
	/** Display name for {@link fallbackAgentId}. */
	fallbackAgentName?: string;
}

const tabs = new Map<string, TabSession>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
const WORKER_INIT_TIMEOUT_MS = 15_000;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
class RecoverableWorkerError extends ToolError {}
const REPORTED_INIT_FAILURE = Symbol("reported-init-failure");

type ReportedInitFailure = Error & { [REPORTED_INIT_FAILURE]?: true };

function markReportedInitFailure(error: Error): Error {
	(error as ReportedInitFailure)[REPORTED_INIT_FAILURE] = true;
	return error;
}

function isReportedInitFailure(error: unknown): boolean {
	return error instanceof Error && (error as ReportedInitFailure)[REPORTED_INIT_FAILURE] === true;
}

async function waitForTabCleanup<T>(
	tab: TabSession,
	timeoutMs: number,
	pendingResource: string,
	promise: Promise<T>,
): Promise<T> {
	const message = `Timed out after ${timeoutMs}ms closing ${tab.kindTag} browser tab ${JSON.stringify(tab.name)}; pending resource: ${pendingResource}`;
	try {
		return await withTimeout(promise, timeoutMs, message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw new ToolError(message);
		throw error;
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const result = prior.then(() => acquireTabImpl(name, browser, opts));
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		// Agent-scoped ownership: two agents never share a tab NAME. Reusing a
		// tab the other agent created would let a subagent silently take over
		// (and later release/hand off) the parent's tab, so refuse loudly
		// instead of re-driving someone else's page.
		if (existing.ownerAgentId && opts.agentId && existing.ownerAgentId !== opts.agentId) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} belongs to agent ${JSON.stringify(existing.ownerAgentName ?? existing.ownerAgentId)}; close it or open a different tab name.`,
			);
		}
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.url) {
					reuseSteps.push(
						`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
					);
				}
				if (reuseSteps.length) {
					await runInTabWithSnapshot(
						name,
						{
							code: reuseSteps.join("\n"),
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
						},
						{ cwd: process.cwd() },
					);
				}
				return { tab: tabs.get(name)!, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let createdTargetId: string | undefined;
	let managedAgentTab: boolean | undefined;
	let worker: WorkerHandle;
	try {
		const built = await buildInitPayload(browser, opts);
		initPayload = built.payload;
		createdTargetId = built.createdTargetId;
		managedAgentTab = built.managedAgentTab;
		worker = await spawnTabWorker();
	} catch (error) {
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(
			worker,
			initPayload,
			Math.max(WORKER_INIT_TIMEOUT_MS, opts.timeoutMs + GRACE_MS),
		);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await worker.terminate().catch(() => undefined);
		if (worker.mode === "inline" || isReportedInitFailure(error)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: error instanceof Error ? error.message : String(error),
		});
		worker = await spawnInlineWorker();
		try {
			info = await initializeTabWorker(
				worker,
				initPayload,
				Math.max(WORKER_INIT_TIMEOUT_MS, opts.timeoutMs + GRACE_MS),
			);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker, tear
	// the freshly-built worker down before publishing the tab so the browser
	// refCount (which `holdBrowser` below would take) never grows for a tab
	// nobody is waiting for. Mirror the error paths' `refCount === 0` release so
	// a fresh browser held by nothing but this aborted open is not orphaned in
	// the registry; a browser still leased/held elsewhere (refCount > 0) is left
	// for its owner to release.
	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		activateForScreenshot: initPayload.mode === "headless" || initPayload.activateForScreenshot !== false,
		ownerSessionId: opts.ownerSessionId,
		ownerAgentId: opts.agentId,
		ownerAgentName: opts.agentName,
		parentAgentId: opts.parentAgentId,
		parentAgentName: opts.parentAgentName,
		parentSessionId: opts.parentSessionId,
		createdTargetId,
		managedAgentTab,
		// The open itself published the creating agent on that dedicated tab.
		publishedAgentId: managedAgentTab ? opts.agentId : undefined,
	};
	worker.onMessage(msg => handleTabMessage(tab, msg));
	tabs.set(name, tab);
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
			ownerAgentId: opts.agentId,
			ownerAgentName: opts.agentName,
			parentAgentId: opts.parentAgentId,
			parentAgentName: opts.parentAgentName,
			parentSessionId: opts.parentSessionId,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			session: opts.session,
			agentId: opts.agentId,
			agentName: opts.agentName,
			onOperations: opts.onOperations,
		},
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: {
		code: string;
		timeoutMs: number;
		signal?: AbortSignal;
		session?: ToolSession;
		agentId?: string;
		agentName?: string;
		onOperations?: (operations: BrowserOperation[]) => void;
	},
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) {
		// Mutex: a tab drives one run at a time (the check and the `pending.set`
		// below are in the same synchronous turn, so two callers cannot both
		// pass). Naming the current operator makes the rejection actionable when
		// a parent and its subagent race for the same shared tab.
		const operator = tab.activeAgentId ? ` by agent ${JSON.stringify(tab.activeAgentName ?? tab.activeAgentId)}` : "";
		throw new ToolError(`Tab ${JSON.stringify(name)} is busy${operator}`);
	}
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	// `releaseTab` calls `pending.reject(closeError)` when the tab dies
	// out from under an in-flight run (sibling `browser close --all`,
	// session-scoped reap, etc.). Both backends below MUST end up awaiting
	// this same `promise` so:
	//   1. The caller sees `Tab ... was closed` immediately instead of
	//      blocking to the run's timeout, and
	//   2. `reject(...)` always has an attached handler — a zero-consumer
	//      rejection would fire `unhandledRejection` and the CLI's
	//      top-level handler would tear the whole session down, killing
	//      every other tab and subagent sharing the process (issue #4499).
	// The cmux branch also composes `closeAc.signal` into the run's abort
	// signal so `wait(...)`, cmux socket calls, and the facade proxies
	// unwind promptly when the tab is closed — otherwise a `wait(60_000)`
	// with no in-flight socket request would keep `runCmuxCode` blocked
	// until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		onOperations: opts.onOperations,
		closeAc,
	};
	tab.pending.set(id, pending);
	tab.activeAgentId = opts.agentId;
	tab.activeAgentName = opts.agentName;
	// The panel badge names the agent driving the page, so a run by a different
	// agent (parent after a hand-off, or a sibling sharing the dedicated tab)
	// republishes it. Skipped when the operator is already published.
	publishTabOperator(tab, opts.agentId, opts.agentName);
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// `runCmuxCode.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
				onOperations: opts.onOperations,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
			clearRunAgent(tab, opts.agentId);
		}
	}
	const abort = (): void => {
		tab.worker.send({ type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		tab.worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
		});
		try {
			return await raceWithTimeout(
				promise,
				opts.timeoutMs + GRACE_MS,
				"Browser code execution hung past grace; tab killed",
				async reason => await forceKillTab(name, reason),
			);
		} catch (error) {
			const runTimedOut =
				error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ");
			if (runTimedOut || error instanceof RecoverableWorkerError) {
				try {
					if (tab.worker.mode === "inline") {
						const reason = runTimedOut
							? "Browser code execution timed out; tab killed"
							: "Browser request interception cleanup failed; tab killed";
						await forceKillTab(name, reason);
					} else {
						await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
					}
				} catch (recycleError) {
					logger.warn("Failed to recycle browser tab worker; killing tab", {
						error: recycleError instanceof Error ? recycleError.message : String(recycleError),
					});
					await forceKillTab(name, "Browser tab worker recovery failed; tab killed");
				}
			}
			throw error;
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
		clearRunAgent(tab, opts.agentId);
	}
}

/** Clear the run-operator marker once this run no longer holds the tab. */
function clearRunAgent(tab: TabSession, agentId: string | undefined): void {
	if (tab.activeAgentId !== agentId) return;
	tab.activeAgentId = undefined;
	tab.activeAgentName = undefined;
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_CLOSE_TIMEOUT_MS;
	if (tab.backend === "worker") await closeCreatedTarget(tab);
	if (tab.backend === "cmux") {
		let closeError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`cmux surface ${JSON.stringify(tab.targetId)} (surface.close)`,
					tab.browser.client.request("surface.close", { surface_id: tab.targetId }, { timeoutMs }),
				);
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: err instanceof Error ? err.message : String(err),
					});
				} else {
					closeError = err;
				}
			}
		}
		try {
			await releaseBrowser(tab.browser, {
				kill: opts.kill ?? false,
				timeoutMs,
				resource: `tab ${JSON.stringify(name)}`,
			});
		} catch (error) {
			closeError ??= error;
		} finally {
			tabs.delete(name);
		}
		if (closeError) throw closeError;
		return true;
	}
	let cleanupError: unknown;
	let forced = false;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
		} catch {
			forced = true;
		}
	}
	await tab.worker.terminate().catch(() => undefined);
	if (forced && tab.kindTag === "headless") {
		try {
			await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab),
			);
		} catch (error) {
			cleanupError = error;
		}
	}
	try {
		await releaseBrowser(tab.browser, {
			kill: opts.kill ?? false,
			timeoutMs,
			resource: `tab ${JSON.stringify(name)}`,
		});
	} catch (error) {
		cleanupError ??= error;
	} finally {
		tabs.delete(name);
	}
	if (cleanupError) throw cleanupError;
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

/**
 * Release every tab created by the given session id. Invoked from
 * `AgentSession.dispose()` so headless/spawned Chromium and workers the
 * session opened do not leak into the long-lived process — the module-global
 * `tabs`/`browsers` maps that back this tool are not otherwise walked by
 * session teardown. (Issue #3963.)
 *
 * Ownership is recorded ONLY on tab creation (`acquireTab` with
 * `ownerSessionId`), never on reuse: a subagent re-driving a tab another
 * session opened will not yank teardown responsibility away from the
 * creator. Tabs opened with no owner (e.g. from an SDK caller that doesn't
 * identify a session) are skipped and must be released explicitly.
 *
 * Passing {@link ReleaseTabsForOwnerOptions.agentId} narrows the reap to tabs
 * that agent created, and
 * {@link ReleaseTabsForOwnerOptions.fallbackAgentId} turns the reap into a
 * hand-off: the tabs stay alive and their ownership moves to the spawning
 * agent. `AgentSession.dispose()` uses both so a finishing subagent never
 * closes a tab its parent — or the user — is still driving.
 */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabsForOwnerOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const { agentId, fallbackAgentId, fallbackAgentName, ...releaseOpts } = opts;
	const targets = [...tabs.values()].filter(
		tab => tab.ownerSessionId === ownerId && (agentId === undefined || tab.ownerAgentId === agentId),
	);
	let count = 0;
	for (const tab of targets) {
		// The spawning agent recorded when the tab was created is the default
		// hand-off target, so session teardown only needs to know its own id.
		const handoffAgentId = fallbackAgentId ?? tab.parentAgentId;
		const handoffAgentName = fallbackAgentId === undefined ? tab.parentAgentName : fallbackAgentName;
		const handOff = agentId !== undefined && handoffAgentId !== undefined && handoffAgentId !== agentId;
		// A user-driven browser (their Chrome via relay/CDP) is never closed by
		// an agent-scoped reap: the page outlives our record, so hand ownership
		// back instead of tearing the supervisor entry down under the parent.
		// The managed panel page the daemon itself created is the exception —
		// no one opened it by hand, so owning it means closing it.
		if (agentId !== undefined && (tab.kindTag === "connected" || tab.kindTag === "relay")) {
			if (handOff) {
				assignTabAgent(tab, handoffAgentId, handoffAgentName);
				continue;
			}
			if (!tab.createdTargetId) {
				dropTabAgent(tab);
				continue;
			}
		}
		// A subagent disposes independently while its parent keeps running.
		// Its tabs revert to the parent instead of closing, so a finished child
		// never shuts a tab the parent (or the user watching it) still uses.
		if (handOff) {
			assignTabAgent(tab, handoffAgentId, handoffAgentName);
			continue;
		}
		if (await releaseTab(tab.name, releaseOpts)) count++;
	}
	return count;
}

/** Move tab ownership to another agent without touching the live page. */
function assignTabAgent(tab: TabSession, agentId: string, agentName: string | undefined): void {
	tab.ownerAgentId = agentId;
	tab.ownerAgentName = agentName ?? agentId;
	// A subagent that minted its own session id hands the reap key to the
	// parent's live session; the shared-transcript case is a no-op.
	if (tab.parentSessionId) tab.ownerSessionId = tab.parentSessionId;
	tab.parentAgentId = undefined;
	tab.parentAgentName = undefined;
	tab.parentSessionId = undefined;
	// The panel still badges the finished child until the parent republishes;
	// rename the dedicated agent tab now so "操作者" follows the hand-off.
	publishTabOperator(tab, agentId, tab.ownerAgentName);
}

/**
 * Publish `agentId` as the operator of the managed browser's dedicated agent
 * tab, so the panel badge ("操作者：X") follows a hand-off or a run by another
 * agent. Best-effort: a closed bridge or an older shell must not turn a
 * hand-off into a failure, and only the dedicated tab is renamed — an adopted
 * user page is never touched.
 */
function publishTabOperator(tab: TabSession, agentId: string | undefined, agentName: string | undefined): void {
	if (!agentId || !tab.managedAgentTab || tab.publishedAgentId === agentId) return;
	if (tab.backend !== "worker") return;
	const browser = tab.browser;
	if (browser.kind.kind !== "connected" || browser.kind.gui !== true) return;
	tab.publishedAgentId = agentId;
	publishManagedOperator(browser, { agentId, agentName }).catch(error => {
		logger.debug("Failed to republish managed-browser operator", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
}

/** Keep the tab alive but stop attributing it to any agent. */
function dropTabAgent(tab: TabSession): void {
	tab.ownerAgentId = undefined;
	tab.ownerAgentName = undefined;
	tab.parentAgentId = undefined;
	tab.parentAgentName = undefined;
	tab.parentSessionId = undefined;
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): ReadonlyMap<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

/** A tab-worker payload plus the panel tab this open created, if any. */
interface InitPayloadBuild {
	payload: WorkerInitPayload;
	/** Set when the managed bridge had no dedicated agent tab to reuse. */
	createdTargetId?: string;
	/** Set when the tab drives the managed browser's dedicated agent tab. */
	managedAgentTab?: boolean;
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<InitPayloadBuild> {
	const safeDir = getPuppeteerDir();
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		return {
			payload: {
				mode: "headless",
				browserWSEndpoint,
				safeDir,
				viewport: opts.viewport,
				dialogs: opts.dialogs,
				url: opts.url,
				waitUntil: opts.waitUntil,
				timeoutMs: opts.timeoutMs,
			},
		};
	}
	// Connected and relay browsers are user-driven. When no target is requested,
	// adopt the visible tab and avoid raising it before screenshots. An explicit
	// target may be backgrounded, so retain activation for target-correct pixels.
	// Managed GUI guests stay composited in the app host even while another tab
	// is foregrounded, so a screenshot never needs to steal the user's focus.
	const userDriven = browser.kind.kind === "connected" || browser.kind.kind === "relay";
	const isManagedGui = browser.kind.kind === "connected" && browser.kind.gui === true;
	const activateForScreenshot = isManagedGui
		? false
		: !userDriven || !shouldPreserveConnectedBrowserFocus(opts.target);
	// The GUI managed browser keeps a DEDICATED agent tab (created on first
	// open, badged in the panel) unless the caller names a target. An explicit
	// `app.target` adopts the matching OPEN tab by url/title substring — the
	// lookup never selects it — and a miss fails instead of falling back to a
	// fresh agent tab that would silently ignore the requested page.
	const managed = isManagedGui
		? await requestManagedBrowserTarget(browser, opts.target, {
				agentId: opts.agentId,
				agentName: opts.agentName,
			})
		: undefined;
	const targetId = managed
		? managed.targetId
		: await targetIdForPage(
				await pickElectronTarget(browser.browser, {
					matcher: opts.target,
					preferVisible: !activateForScreenshot,
				}),
			);
	return {
		payload: {
			mode: "attach",
			browserWSEndpoint,
			safeDir,
			targetId,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
			activateForScreenshot,
			...(isManagedGui ? { managedGui: true, uploadBridge: uploadBridgeOrigin(browser) } : {}),
		},
		...(managed?.created ? { createdTargetId: managed.targetId } : {}),
		// Only the dedicated agent tab can be re-badged later: an adopted
		// `app.target` page belongs to the user and carries no operator.
		...(managed && !managed.created && !opts.target ? { managedAgentTab: true } : {}),
	};
}

/** Managed-browser bridge origin for the in-app upload card; only the desktop
 *  GUI backend has one (relay/plain CDP keep their own picker behavior). */
function uploadBridgeOrigin(browser: PuppeteerBrowserHandle): string | undefined {
	if (browser.kind.kind !== "connected" || browser.kind.gui !== true) return undefined;
	return browser.kind.cdpUrl.replace(/\/+$/, "");
}

/**
 * Page target the managed browser bridge handed out, plus whether this open
 * created it (`Target.createTarget`) and therefore owns closing it.
 */
export interface ManagedBrowserTarget {
	targetId: string;
	created: boolean;
}

/** Browser-level CDP session on the managed bridge; always detached. */
async function withManagedSession<T>(
	browser: PuppeteerBrowserHandle,
	fn: (raw: { send(method: string, params?: object): Promise<{ targetId?: string | null }> }) => Promise<T>,
): Promise<T> {
	const session = await browser.browser.target().createCDPSession();
	try {
		return await fn(
			session as unknown as { send(method: string, params?: object): Promise<{ targetId?: string | null }> },
		);
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/**
 * Tell the bridge who is driving its dedicated agent tab so the panel badge
 * ("操作者：X") follows the actual operator. Never creates a tab: only a tab
 * that came from `ensureAgentTab` is ever re-badged.
 */
async function publishManagedOperator(browser: PuppeteerBrowserHandle, identity: BrowserAgentIdentity): Promise<void> {
	await withManagedSession(browser, raw => raw.send("ManagedBrowser.ensureAgentTab", agentCdpParams(identity)));
}

/**
 * Ask the managed browser bridge (browser.gui) for the page target id to drive.
 * Without a target, the bridge creates or reuses the DEDICATED agent tab;
 * with one, it resolves an already-open tab by url/title substring and never
 * creates or selects anything. Uses the browser-level CDP session so no page
 * needs to exist yet; the bridge answers private methods the same way the
 * relay answers `MusePi.claimTarget`.
 *
 * `identity` names the operating agent on that tab ("操作者：X"). It is sent as
 * `agentId`/`agentName` only, and omitted entirely for an unidentified caller
 * so user-tab payloads keep their old shape.
 */
export async function requestManagedBrowserTarget(
	browser: PuppeteerBrowserHandle,
	target?: string,
	identity?: BrowserAgentIdentity,
): Promise<ManagedBrowserTarget> {
	return await withManagedSession(browser, async raw => {
		if (target) {
			const resolved = await raw.send("ManagedBrowser.findTabTarget", { target });
			if (!resolved.targetId) {
				throw new ToolError(`No open managed-browser tab matches app.target ${JSON.stringify(target)}`);
			}
			return { targetId: resolved.targetId, created: false };
		}
		const agent = agentCdpParams(identity);
		try {
			const ensured = await raw.send("ManagedBrowser.ensureAgentTab", agent);
			if (!ensured.targetId) throw new ToolError("The managed browser did not provide an agent tab target");
			return { targetId: ensured.targetId, created: false };
		} catch (error) {
			// A shell that predates the private method still speaks standard CDP.
			// Creating the tab ourselves keeps the open working and still badges
			// it, at the cost of owning its lifetime (see `createdTargetId`).
			if (!isUnknownCdpMethodError(error, "ManagedBrowser.ensureAgentTab")) throw error;
			const fallback = await raw.send("Target.createTarget", { url: "about:blank", ...agent });
			if (!fallback.targetId) throw new ToolError("The managed browser did not provide an agent tab target");
			return { targetId: fallback.targetId, created: true };
		}
	});
}

function handleTabMessage(tab: WorkerTabSession, msg: WorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		if (msg.error.operations) pending.onOperations?.(msg.error.operations);
		pending.reject(errorFromPayload(msg.error));
		return;
	}
	if (msg.type === "activity") {
		tab.pending.get(msg.id)?.onOperations?.(msg.operations);
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

async function dispatchToolCall(
	tab: WorkerTabSession,
	msg: Extract<WorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: WorkerTabSession, msg: WorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(tab: WorkerTabSession, timeoutMs: number): Promise<void> {
	const oldWorker = tab.worker;
	await oldWorker.terminate().catch(() => undefined);
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		safeDir: getPuppeteerDir(),
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
		timeoutMs,
		activateForScreenshot: tab.activateForScreenshot,
		...(tab.browser.kind.kind === "connected" && tab.browser.kind.gui === true
			? { managedGui: true, uploadBridge: uploadBridgeOrigin(tab.browser) }
			: {}),
	};
	let worker = await spawnTabWorker();
	try {
		const info = await initializeTabWorker(worker, payload, timeoutMs);
		tab.worker = worker;
		tab.info = info;
		tab.state = "alive";
		worker.onMessage(msg => handleTabMessage(tab, msg));
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		worker = await spawnInlineWorker();
		try {
			const info = await initializeTabWorker(worker, payload, timeoutMs);
			tab.worker = worker;
			tab.info = info;
			tab.state = "alive";
			worker.onMessage(msg => handleTabMessage(tab, msg));
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			const finalError = new ToolError(
				`Failed to recycle timed-out browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			Object.defineProperty(finalError, "cause", { value: error, configurable: true });
			throw finalError;
		}
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	killedTabs.set(name, reason);
	tab.state = "dead";
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		tabs.delete(name);
		return;
	}
	await tab.worker.terminate().catch(() => undefined);
	if (tab.kindTag === "headless") await closeOrphanTarget(tab);
	else await closeCreatedTarget(tab);
	await releaseBrowser(tab.browser, { kill: false });
	tabs.delete(name);
}

async function closeCreatedTarget(tab: WorkerTabSession): Promise<void> {
	const targetId = tab.createdTargetId;
	if (!targetId) return;
	// The page lives in the managed panel, not in a Chromium we launched, so it
	// is closed through CDP rather than by terminating a process. Best-effort:
	// a shell that already dropped the tab must not fail the release.
	let session: CDPSession | undefined;
	try {
		session = await tab.browser.browser.target().createCDPSession();
		// `Target.closeTarget` is a browser-domain command puppeteer's session
		// types cover; the generic send shape keeps this independent of them.
		const raw = session as unknown as { send(method: string, params: object): Promise<unknown> };
		await raw.send("Target.closeTarget", { targetId });
	} catch (error) {
		logger.debug("Failed to close managed-browser target", {
			targetId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		await session?.detach().catch(() => undefined);
	}
}

async function closeOrphanTarget(tab: WorkerTabSession): Promise<void> {
	for (const target of tab.browser.browser.targets()) {
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		const page = await target.page().catch(() => null);
		await page?.close().catch(() => undefined);
		return;
	}
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, "Timed out closing browser tab worker");
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.recoverTab
		? new RecoverableWorkerError(payload.message)
		: payload.isAbort
			? new ToolAbortError()
			: payload.isToolError
				? new ToolError(payload.message)
				: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_tab"] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return spawnInlineWorker();
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/**
 * Inline fallback for environments where Bun cannot compile or spawn the worker
 * entry. This preserves normal browser behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
async function spawnInlineWorker(): Promise<WorkerHandle> {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg as WorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (message: WorkerInbound) => void;
			workerListeners.add(typed);
			return () => workerListeners.delete(typed);
		},
		close: () => {},
	};
	const { WorkerCore } = await import("./tab-worker");
	new WorkerCore(workerTransport, false);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async terminate() {},
	};
}

async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<ReadyInfo>();
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "ready") resolve(msg.info);
		else if (msg.type === "init-failed") reject(markReportedInitFailure(errorFromPayload(msg.error)));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		reject(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		return await raceWithTimeout(promise, timeoutMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}
