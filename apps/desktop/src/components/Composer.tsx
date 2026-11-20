/**
 * One composer entry, two states.
 *
 * The session composer and the empty state used to be two components imported
 * side by side, so every behavior one of them learned (completion menus,
 * attachment intake, draft persistence, dictation) had to be copied into the
 * other. They now sit behind ONE entry with a mode discriminant and share the
 * controllers in `composer/` (useCompletion, useAttachments, useDictation,
 * long-paste, the frame). `mode` is optional for the session state so existing
 * session call sites read unchanged; the empty state must say `mode="hero"`.
 */
import { type ComponentProps, type ReactNode, useCallback, useState } from "react";
import { registerHostModule } from "../lib/host-modules";
import { HeroComposer } from "./HeroComposer";
import { SessionComposer, type SessionComposerProps } from "./SessionComposer";

export type HeroComposerProps = ComponentProps<typeof HeroComposer>;

export type ComposerProps = ({ mode?: "session" } & SessionComposerProps) | ({ mode: "hero" } & HeroComposerProps);

export function Composer(props: ComposerProps): ReactNode {
	// The draft lives HERE: this entry keeps its identity across a welcome ⇄
	// session flip (ChatView mounts it once in the composer host), so the text
	// survives the skin change. `carry` is the one-shot handoff the session skin
	// may adopt when that session has no stored draft of its own — without it
	// `useDraftPersistence` restores "" and the carried text disappears.
	const [draft, setDraft] = useState("");
	const [carry, setCarry] = useState("");
	const hero = props.mode === "hero";
	const onDraftChange = useCallback(
		(text: string) => {
			setDraft(text);
			setCarry(prev => {
				if (hero) return text;
				return prev !== "" && text === prev ? "" : prev;
			});
		},
		[hero],
	);
	const handoff = { initialDraft: draft, onDraftChange, ...(hero ? {} : { carryDraft: carry }) };
	return hero ? <HeroComposer {...props} {...handoff} /> : <SessionComposer {...props} {...handoff} />;
}

// The compiled input-card artifact imports this module through the host table
// (EXTENSION_HOST_MODULES "composer"); register the same instance the shell
// uses so the seat and the fallback share one component module.
registerHostModule("composer", { Composer });
