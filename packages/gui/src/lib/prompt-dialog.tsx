import { t } from "@musepi/collab-web";
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

	const finish = (v: string | null | boolean): void => {
		if (state?.kind === "confirm") {
			confirmRef.current?.(v === true);
			confirmRef.current = null;
		} else {
			resolverRef.current?.(typeof v === "string" ? v : null);
			resolverRef.current = null;
		}
		setState(null);
	};

	// Escape closes either dialog (the confirm box has no input to hang a
	// keydown on, so the listener is document-level while it is open).
	useEffect(() => {
		if (!state) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") finish(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	return (
		<PromptContext.Provider value={prompt}>
			<ConfirmContext.Provider value={confirm}>
				{children}
				{state &&
					createPortal(
						<div className="gui-dialog-backdrop" onClick={() => finish(null)}>
							<div
								className="gui-dialog gui-dialog--prompt"
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
