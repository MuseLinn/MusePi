import { ComposerEditor } from "@musepi/client-core/src/components/composer/ComposerEditor";
import type { ComponentProps, ReactNode, RefObject } from "react";

type EditorProps = ComponentProps<typeof ComposerEditor>;

/** IME guards for the skins whose Enter handling reads the flag.
 *
 * A composition can end without `compositionend` (IME cancel, window switch,
 * Esc, renderer reload), so losing focus also terminates it. The deferred
 * `compositionend` clear exists because WebKit dispatches the confirming Enter
 * after that event, when `isComposing` is already false.
 */
function compositionHandlers(composingRef?: RefObject<boolean>): Partial<EditorProps> {
	if (!composingRef) return {};
	return {
		onCompositionStart: () => {
			composingRef.current = true;
		},
		onCompositionEnd: () => {
			setTimeout(() => {
				composingRef.current = false;
			}, 0);
		},
		onBlur: () => {
			composingRef.current = false;
		},
		onFocus: () => {
			composingRef.current = false;
		},
	};
}

/** One editor stack for both composer skins (ADR 0004 step 2).
 *
 * The two skins used to render their own `gui-ta-stack` around the same
 * `ComposerEditor`: same ref wiring, same composition lifecycle, same
 * suggestion chip — differing only in the skin class and the placeholder text.
 * This component is that block with the skin as a prop, so the merged body has
 * one editor mount and the variant only chooses the skin.
 *
 * Completion menus stay out: the frame's float layer owns the anchor and the
 * open state, so this stays a pure editor surface.
 */
export interface ComposerEditorStackProps {
	variant: EditorProps["variant"];
	editorRef: EditorProps["ref"];
	value: string;
	focused?: boolean;
	className: string;
	placeholder: string;
	spellCheck: boolean;
	/** Marks the host for `composer-input-redirect`; the welcome surface focuses itself. */
	dataComposerInput?: boolean;
	autoFocus?: boolean;
	/** IME flag shared with the parent's Enter handling, when it reads one. */
	composingRef?: RefObject<boolean>;
	onChange: EditorProps["onChange"];
	onKeyDown: EditorProps["onKeyDown"];
	onPaste: EditorProps["onPaste"];
	onDragOver: EditorProps["onDragOver"];
	onDrop: EditorProps["onDrop"];
	marks: EditorProps["marks"];
	resolveMention: EditorProps["resolveMention"];
	onMentionClick: EditorProps["onMentionClick"];
	/** Inline ghost suggestion under the editor (null hides the row). */
	suggestion?: string | null;
	/** The suggestion row's accept hint. */
	acceptHint?: ReactNode;
}

export function ComposerEditorStack({
	variant,
	editorRef,
	value,
	focused,
	className,
	placeholder,
	spellCheck,
	dataComposerInput,
	autoFocus,
	composingRef,
	onChange,
	onKeyDown,
	onPaste,
	onDragOver,
	onDrop,
	marks,
	resolveMention,
	onMentionClick,
	suggestion = null,
	acceptHint,
}: ComposerEditorStackProps): ReactNode {
	return (
		<div className="gui-ta-stack">
			<ComposerEditor
				ref={editorRef}
				value={value}
				dataComposerInput={dataComposerInput}
				dataFocused={focused}
				variant={variant}
				className={className}
				onPaste={onPaste}
				onDragOver={onDragOver}
				onDrop={onDrop}
				onChange={onChange}
				{...compositionHandlers(composingRef)}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				spellCheck={spellCheck}
				autoComplete="off"
				autoFocus={autoFocus}
				marks={marks}
				resolveMention={resolveMention}
				onMentionClick={onMentionClick}
			/>
			{suggestion !== null && (
				<span className="gui-composer-suggestion" aria-hidden>
					<span className="gui-composer-suggestion-text">{suggestion}</span>
					<kbd className="gui-composer-suggestion-key">{acceptHint}</kbd>
				</span>
			)}
		</div>
	);
}
