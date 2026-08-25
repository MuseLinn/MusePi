/**
 * /btw floating side-question card (TUI parity for the desktop GUI).
 *
 * TUI /btw runs an ephemeral turn that answers a side question WITHOUT
 * touching the session transcript; the GUI equivalent intercepts the slash
 * command in Composer and drives the same runEphemeralTurn path via the
 * daemon's session.ephemeralAsk RPC. This card floats above the chat
 * surface (bottom-right, above the composer), streams the answer state
 * (asking → done/error), and supports follow-up questions in the same
 * context plus a stop action for in-flight turns.
 *
 * State machine: idle → asking(question) → done(answer) | error(message)
 * → (follow-up) asking(next) → …  Close dismisses the whole card; stop
 * abandons the current request (the daemon side channel keeps running but
 * its result is discarded — runEphemeralTurn has no cross-request cancel).
 */
import { type TranslationKey, t } from "@musepi/desktop-web";
import { Sparkles, StopCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Markdown } from "@musepi/desktop-web";

export interface BtwQuestion {
	question: string;
}

interface BtwTurn {
	question: string;
	answer: string;
	error?: string;
}

/**
 * Floating /btw card. `onAsk` is the daemon call (kept in the parent so the
 * card stays a pure view; ChatView wires rpc + sessionId). When `onAsk`
 * returns null the caller signals "no session / cannot run" and the card
 * shows a friendly error.
 */
export function BtwFloatingCard({
	initialQuestion,
	onAsk,
	onClose,
}: {
	initialQuestion: string;
	onAsk(question: string, history: BtwTurn[]): Promise<{ replyText: string } | null>;
	onClose(): void;
}): React.ReactNode {
	const [turns, setTurns] = useState<BtwTurn[]>([]);
	const [input, setInput] = useState("");
	const [asking, setAsking] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const historyRef = useRef<BtwTurn[]>([]);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const ask = useCallback(
		async (question: string): Promise<void> => {
			const history = [...historyRef.current];
			const turn: BtwTurn = { question, answer: "" };
			setTurns([...history, turn]);
			setAsking(true);
			try {
				const res = await onAsk(question, history);
				if (res === null) {
					const failed = { ...turn, error: t("btw unavailable — no active session") };
					historyRef.current = [...history, failed];
					setTurns(historyRef.current);
					return;
				}
				const done = { ...turn, answer: res.replyText };
				historyRef.current = [...history, done];
				setTurns(historyRef.current);
			} catch {
				const failed = { ...turn, error: t("btw failed — check the daemon connection") };
				historyRef.current = [...history, failed];
				setTurns(historyRef.current);
			} finally {
				setAsking(false);
			}
		},
		[onAsk],
	);

	useEffect(() => {
		void ask(initialQuestion);
	}, [initialQuestion, ask]);

	const submitFollowUp = (): void => {
		const q = input.trim();
		if (!q || asking) return;
		setInput("");
		void ask(q);
	};

	return (
		<div
			className="gui-btw-card"
			role="dialog"
			aria-label={t("side question")}
			onKeyDown={e => {
				if (e.key === "Escape") onClose();
			}}
			style={{ position: "fixed", bottom: 96, right: 24, zIndex: 2900, width: 380, maxWidth: "calc(100vw - 48px)" }}
		>
			<div className="gui-btw-head">
				<Sparkles size={13} />
				<span className="gui-btw-title">{t("side question")}</span>
				<button
					type="button"
					className="gui-btw-x"
					aria-label={t("close")}
					onClick={onClose}
				>
					<X size={14} />
				</button>
			</div>
			<div className="gui-btw-body">
				{turns.map((turn, i) => (
					<div className="gui-btw-turn" key={i}>
						<div className="gui-btw-q">{turn.question}</div>
						{turn.error ? (
							<div className="gui-btw-error">{turn.error}</div>
						) : asking && i === turns.length - 1 && turn.answer === "" ? (
							<div className="gui-btw-loading">
								<span className="gui-btw-spinner" aria-hidden />
								{t("thinking…")}
							</div>
						) : (
							<div className="gui-btw-a">
								<Markdown text={turn.answer || "…"} />
							</div>
						)}
					</div>
				))}
			</div>
			<div className="gui-btw-foot">
				{asking && (
					<button
						type="button"
						className="gui-btw-stop"
						onClick={() => setAsking(false)}
						title={t("stop")}
					>
						<StopCircle size={13} />
						<span>{t("stop")}</span>
					</button>
				)}
				<input
					ref={inputRef}
					className="gui-btw-input"
					value={input}
					placeholder={t("follow up…")}
					disabled={asking}
					onChange={e => setInput(e.target.value)}
					onFocus={() => setInputFocused(true)}
					onBlur={() => setInputFocused(false)}
					onKeyDown={e => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submitFollowUp();
						}
					}}
				/>
				<button
					type="button"
					className="gui-btw-send"
					disabled={asking || input.trim().length === 0}
					onClick={submitFollowUp}
				>
					{t("ask")}
				</button>
			</div>
			{inputFocused && (
				<div className="gui-btw-hint">{t("Enter to ask — Esc closes")}</div>
			)}
		</div>
	);
}
