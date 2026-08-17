import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface PromptSpec {
	title: string;
	defaultValue?: string;
	placeholder?: string;
}

type PromptFn = (spec: PromptSpec) => Promise<string | null>;
/** Confirm message — resolves true on confirm, false on cancel/Escape. */
type ConfirmFn = (message: string, okLabel?: string) => Promise<boolean>;

interface DialogState {
	kind: "prompt" | "confirm";
	spec: PromptSpec;
	okLabel?: string;
}

const PromptContext = createContext<PromptFn>(async () => null);
const ConfirmContext = createContext<ConfirmFn>(async () => false);

/**
 * Promise-based text prompt (Electron sandbox has NO window.prompt — it
 * returns null silently, which broke rename/goal flows). Rendered as a
 * portaled dialog; resolves the trimmed value, or null on cancel/Escape.
 */
export function usePrompt(): { prompt: PromptFn } {
	return { prompt: useContext(PromptContext) };
}

/** Promise-based confirm (Electron sandbox also silences window.confirm —
 * it resolves false without ever asking, so destructive actions must use
 * this dialog instead of the native confirm). */
export function useConfirm(): { confirm: ConfirmFn } {
	return { confirm: useContext(ConfirmContext) };
}

export function PromptProvider({ children }: { children: ReactNode }): ReactNode {
	const [state, setState] = useState<DialogState | null>(null);
	// Enter/closing phases (DialogFrame parity): first frame paints at
	// opacity 0 so the frosted backdrop composites before the fade starts,
	// then --entered runs the scale/fade-in; finish() flips to closing and
	// keeps the dialog mounted through the exit animation before the state
	// clears — so confirm dialogs (session delete, project remove, …) get
	// the same show/hide motion as every other modal.
	const [phase, setPhase] = useState<"enter" | "open" | "closing">("open");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [value, setValue] = useState("");
	const resolverRef = useRef<((v: string | null) => void) | null>(null);
	const confirmRef = useRef<((v: boolean) => void) | null>(null);

	const prompt = useCallback((s: PromptSpec): Promise<string | null> => {
		setValue(s.defaultValue ?? "");
		setState({ kind: "prompt", spec: s });
		return new Promise<string | null>(resolve => {
			resolverRef.current = resolve;
		});
	}, []);

	const confirm = useCallback((message: string, okLabel?: string): Promise<boolean> => {
		setValue("");
		setState({ kind: "confirm", spec: { title: message }, okLabel });
		return new Promise<boolean>(resolve => {
			confirmRef.current = resolve;
		});
	}, []);

	// Enter: two rAF hops then --entered (same pattern as DialogFrame /
	// useFloatingMenu), with a timer fallback for throttled rAF.
	useEffect(() => {
		if (!state) return;
		setPhase("enter");
		const advance = (): void => {
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = requestAnimationFrame(() => setPhase("open"));
			});
		};
		advance();
		timerRef.current = setTimeout(() => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			setPhase("open");
		}, 80);
		return () => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			if (timerRef.current !== null) clearTimeout(timerRef.current);
		};
	}, [state]);

	const finish = useCallback(
		(v: string | null | boolean): void => {
			if (phase === "closing") return;
			setPhase("closing");
			if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
			exitTimerRef.current = setTimeout(() => {
				if (state?.kind === "confirm") {
					confirmRef.current?.(v === true);
					confirmRef.current = null;
				} else {
					resolverRef.current?.(typeof v === "string" ? v : null);
					resolverRef.current = null;
				}
				setState(null);
				setPhase("open");
			}, 180);
		},
		[phase, state],
	);

	// Escape cancels either dialog; Enter confirms a confirm box (a prompt
	// has its own input handler). The confirm box has no input to hang a
	// keydown on, so the listener is document-level while it is open — in
	// capture phase so the modal wins over the page behind.
	//
	// Focus: a PROMPT focuses its text input (typing must land immediately —
	// focusing the button instead stole focus on every keystroke because the
	// effect re-ran after each render); a confirm box focuses its confirm
	// button so Enter/Escape visibly land on it. The [state, phase] deps keep
	// the effect from re-arming mid-typing: `state` arms it on open, `phase`
	// refreshes the closing guard. `value` is intentionally NOT a dep.
	useEffect(() => {
		if (!state) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				finish(null);
			} else if (e.key === "Enter" && state.kind === "confirm" && phase !== "closing") {
				finish(true);
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [state, phase, finish]);

	// Initial focus, once per open: the prompt input, else the confirm button.
	// Runs on open only — re-focusing on every keystroke stole typing.
	useEffect(() => {
		if (!state) return;
		const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const raf = requestAnimationFrame(() => {
			const dlg = document.querySelector<HTMLElement>(".gui-dialog--prompt");
			const target = dlg?.querySelector<HTMLElement>(state.kind === "prompt" ? "input" : "button");
			target?.focus();
		});
		return () => {
			cancelAnimationFrame(raf);
			prevActive?.focus();
		};
	}, [state]);

	return (
		<PromptContext.Provider value={prompt}>
			<ConfirmContext.Provider value={confirm}>
				{children}
				{state &&
					createPortal(
						<div
							className={`gui-dialog-backdrop${
								phase === "enter"
									? " gui-dialog-backdrop--pending"
									: phase === "closing"
										? " gui-dialog-backdrop--closing"
										: " gui-dialog-backdrop--entered"
							}`}
							onClick={() => finish(null)}
						>
							<div
								className={`gui-dialog gui-dialog--prompt${
									phase === "enter"
										? " gui-dialog--pending"
										: phase === "closing"
											? " gui-dialog--closing"
											: " gui-dialog--entered"
								}`}
								role="dialog"
								aria-modal="true"
								onClick={e => e.stopPropagation()}
							>
								<h3>{state.spec.title}</h3>
								{state.kind === "prompt" ? (
									<input
										className="gui-input mt-2 w-full"
										value={value}
										placeholder={state.spec.placeholder}
										autoFocus
										spellCheck={false}
										onChange={e => setValue(e.target.value)}
										onKeyDown={e => {
											if (e.key === "Enter") finish(value.trim());
											else if (e.key === "Escape") finish(null);
										}}
									/>
								) : null}
								<div className="mt-4 flex justify-end gap-2">
									<button type="button" className="gui-btn" onClick={() => finish(false)}>
										{t("cancel")}
									</button>
									<button
										type="button"
										className="gui-btn gui-btn-primary"
										onClick={() => (state?.kind === "prompt" ? finish(value.trim()) : finish(true))}
									>
										{state.okLabel ?? t("confirm")}
									</button>
								</div>
							</div>
						</div>,
						/* Inside the React root (not body) so delegated listeners fire. */
						document.getElementById("root") ?? document.body,
					)}
			</ConfirmContext.Provider>
		</PromptContext.Provider>
	);
}
