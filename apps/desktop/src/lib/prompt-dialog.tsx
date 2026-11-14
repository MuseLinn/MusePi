import { isTopModal, t, useModalFocus } from "@musepi/client-core";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface PromptSpec {
	title: string;
	defaultValue?: string;
	placeholder?: string;
}

interface ConfirmOptions {
	destructive?: boolean;
}

type PromptFn = (spec: PromptSpec) => Promise<string | null>;
/** Confirm message — resolves true on confirm, false on cancel/Escape. */
type ConfirmFn = (message: string, okLabel?: string, options?: ConfirmOptions) => Promise<boolean>;

interface DialogState {
	kind: "prompt" | "confirm";
	spec: PromptSpec;
	okLabel?: string;
	destructive?: boolean;
}

interface PendingDialog {
	settle(value: string | null | boolean): void;
	cancel(): void;
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
	const [phase, setPhase] = useState<"enter" | "open" | "closing">("open");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<Timer | null>(null);
	const exitTimerRef = useRef<Timer | null>(null);
	const [value, setValue] = useState("");
	const pendingRef = useRef<PendingDialog | null>(null);
	const finishingRef = useRef(false);
	const dialogRef = useModalFocus<HTMLDivElement>(state !== null);

	const cancelPending = useCallback((): void => {
		if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
		exitTimerRef.current = null;
		finishingRef.current = false;
		const pending = pendingRef.current;
		pendingRef.current = null;
		pending?.cancel();
	}, []);

	const prompt = useCallback(
		(s: PromptSpec): Promise<string | null> => {
			cancelPending();
			const { promise, resolve } = Promise.withResolvers<string | null>();
			pendingRef.current = {
				settle: result => resolve(typeof result === "string" ? result : null),
				cancel: () => resolve(null),
			};
			setValue(s.defaultValue ?? "");
			setPhase("open");
			setState({ kind: "prompt", spec: s });
			return promise;
		},
		[cancelPending],
	);

	const confirm = useCallback(
		(message: string, okLabel?: string, options?: ConfirmOptions): Promise<boolean> => {
			cancelPending();
			const { promise, resolve } = Promise.withResolvers<boolean>();
			pendingRef.current = {
				settle: result => resolve(result === true),
				cancel: () => resolve(false),
			};
			setValue("");
			setPhase("open");
			setState({ kind: "confirm", spec: { title: message }, okLabel, destructive: options?.destructive });
			return promise;
		},
		[cancelPending],
	);

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

	useEffect(() => {
		if (!state) return;
		const target = dialogRef.current?.querySelector<HTMLElement>(
			state.kind === "prompt" ? "input" : ".gui-btn:not(.gui-btn-primary)",
		);
		target?.focus();
	}, [state, dialogRef]);

	const finish = useCallback((result: string | null | boolean): void => {
		const pending = pendingRef.current;
		if (!pending || finishingRef.current) return;
		finishingRef.current = true;
		setPhase("closing");
		exitTimerRef.current = setTimeout(() => {
			pendingRef.current = null;
			exitTimerRef.current = null;
			finishingRef.current = false;
			pending.settle(result);
			setState(null);
			setPhase("open");
		}, 180);
	}, []);

	useEffect(() => () => cancelPending(), [cancelPending]);

	useEffect(() => {
		if (!state) return;
		const onKey = (event: KeyboardEvent): void => {
			const dialog = dialogRef.current;
			if (!dialog || !isTopModal(dialog) || phase === "closing") return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				finish(null);
			} else if (event.key === "Enter" && state.kind === "confirm") {
				event.preventDefault();
				event.stopPropagation();
				if (!state.destructive) finish(true);
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [state, phase, finish, dialogRef]);

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
								ref={dialogRef}
								className={`gui-dialog ${
									state.kind === "confirm" ? "gui-dialog--confirm" : "gui-dialog--prompt"
								}${
									phase === "enter"
										? " gui-dialog--pending"
										: phase === "closing"
											? " gui-dialog--closing"
											: " gui-dialog--entered"
								}`}
								role="dialog"
								aria-modal="true"
								aria-label={state.spec.title}
								onClick={event => event.stopPropagation()}
							>
								<h3>{state.spec.title}</h3>
								{state.kind === "prompt" ? (
									<input
										className="gui-input mt-2 w-full"
										value={value}
										placeholder={state.spec.placeholder}
										spellCheck={false}
										onChange={event => setValue(event.target.value)}
										onKeyDown={event => {
											if (event.key === "Enter") finish(value.trim());
											else if (event.key === "Escape") finish(null);
										}}
									/>
								) : null}
								<div className="mt-4 flex justify-end gap-2">
									<button type="button" className="gui-btn" onClick={() => finish(false)}>
										{t("settings.cancel")}
									</button>
									<button
										type="button"
										className="gui-btn gui-btn-primary"
										onClick={() => (state.kind === "prompt" ? finish(value.trim()) : finish(true))}
									>
										{state.okLabel ?? t("settings.confirm")}
									</button>
								</div>
							</div>
						</div>,
						// Body-level portals keep the confirm in the same modal band as
						// drawers and DialogFrame instead of painting beneath them.
						document.body,
					)}
			</ConfirmContext.Provider>
		</PromptContext.Provider>
	);
}
