import { t } from "../i18n/index.js";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import type { RpcClient } from "../lib/rpc";
import { wrapSelectionForChat } from "../lib/selection-capture";
import { tapFeedback } from "../lib/haptic";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Selection→ask popover (openchamber side-chat parity, minimal form):
 * "explain this selection" in a throwaway turn that never touches the
 * transcript. Opened by the musepi-gui-ask window event (Cmd+Shift+L,
 * SelectionToolbar 提问 button, browser-pane 提问选中). The daemon answers
 * via session.ephemeralAsk (AgentSession.runEphemeralTurn side channel) —
 * no journal record, no SDK write, exactly the CLI --no-session semantics.
 */
export interface AskRequest {
	text: string;
	x: number;
	y: number;
	/** Optional source context shown under the snippet (e.g. browser page
	 *  title). */
	context?: string;
}

const MAX_SNIPPET = 240;

export function AskPopover({ rpc, sessionId }: { rpc: RpcClient | null; sessionId: string | null }): ReactNode {
	const [pop, setPop] = useState<AskRequest | null>(null);
	const [question, setQuestion] = useState("");
	const [phase, setPhase] = useState<"input" | "asking" | "done">("input");
	const [reply, setReply] = useState("");
	const [error, setError] = useState<string | null>(null);
	const enteredCls = useTwoPhaseEnter(pop !== null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);

	// Single window-event listener; the pop state lives in a ref so the
	// handler stays stable across re-renders.
	const popRef = useRef(pop);
	popRef.current = pop;
	useEffect(() => {
		const onAsk = (e: Event): void => {
			const detail = (e as CustomEvent<AskRequest>).detail;
			if (!detail?.text) return;
			setPop(detail);
			setQuestion("");
			setPhase("input");
			setReply("");
			setError(null);
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener("musepi-gui-ask", onAsk);
		return () => window.removeEventListener("musepi-gui-ask", onAsk);
	}, []);

	const close = (): void => {
		setPop(null);
		setPhase("input");
		setReply("");
		setError(null);
	};

	const ask = async (): Promise<void> => {
		if (!rpc || !sessionId) return;
		const q = question.trim();
		if (!q) return;
		setPhase("asking");
		setReply("");
		setError(null);
		try {
			const body = `${q}\n\n${t("selection context")}:\n${wrapSelectionForChat(popRef.current?.text ?? "")}`;
			const res = await rpc.request<{ replyText?: string }>("session.ephemeralAsk", {
				sessionId,
				promptText: body,
			});
			setReply(res?.replyText ?? "");
			setPhase("done");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("done");
		}
	};

	// Esc closes; Enter (no shift) sends from the question box.
	const onKeyDown = (e: React.KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		} else if (e.key === "Enter" && !e.shiftKey && phase === "input") {
			e.preventDefault();
			void ask();
		}
	};

	if (!pop) return null;
	const snippet = pop.text.length > MAX_SNIPPET ? `${pop.text.slice(0, MAX_SNIPPET)}…` : pop.text;
	const left = Math.min(pop.x, window.innerWidth - 380);
	const top = Math.max(8, Math.min(pop.y, window.innerHeight - 420));
	return (
		<div
			className={`gui-ask-pop${enteredCls ? " gui-ask-pop--entered" : ""}`}
			role="dialog"
			aria-label={t("ask about selection")}
			style={{ left, top }}
		>
			<div className="gui-ask-pop-head">
				<Icon name="sparkling" className="h-3.5 w-3.5" />
				<span className="gui-ask-pop-title">{t("ask about selection")}</span>
				<button type="button" className="gui-ask-pop-x" aria-label={t("close")} title={t("close")} onClick={close}>
					<Icon name="close" className="h-3 w-3" />
				</button>
			</div>
			<div className="gui-ask-pop-snippet" title={pop.text}>
				{snippet}
			</div>
			{pop.context && <div className="gui-ask-pop-context">{pop.context}</div>}
			{phase === "done" ? (
				<div className="gui-ask-pop-reply">
					{error ? <div className="gui-ask-pop-error">{error}</div> : <pre>{reply || "…"}</pre>}
					<div className="gui-ask-pop-actions">
						<button
							type="button"
							className="gui-ask-pop-btn"
							title={t("copy")}
							onClick={() => {
								tapFeedback();
								void navigator.clipboard.writeText(reply);
							}}
						>
							<Icon name="file-copy-2" className="h-3.5 w-3.5" />
							<span>{t("copy")}</span>
						</button>
						<button
							type="button"
							className="gui-ask-pop-btn"
							title={t("ask another question")}
							onClick={() => {
								setPhase("input");
								setReply("");
								setError(null);
								requestAnimationFrame(() => taRef.current?.focus());
							}}
						>
							<Icon name="chat-1" className="h-3.5 w-3.5" />
							<span>{t("ask another question")}</span>
						</button>
					</div>
				</div>
			) : (
				<div className="gui-ask-pop-input-row">
					<textarea
						ref={taRef}
						className="gui-ask-pop-input"
						rows={2}
						value={question}
						placeholder={t("ask about selection placeholder")}
						onChange={e => setQuestion(e.target.value)}
						onKeyDown={onKeyDown}
						disabled={phase === "asking"}
					/>
					<button
						type="button"
						className="gui-ask-pop-send"
						title={t("ask")}
						disabled={phase === "asking" || !question.trim()}
						onClick={() => void ask()}
					>
						{phase === "asking" ? <span className="gui-ask-pop-dots" /> : <Icon name="arrow-up" className="h-3.5 w-3.5" />}
					</button>
				</div>
			)}
		</div>
	);
}
