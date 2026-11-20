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
import { type ComposerSendPayload, type ComposerSurface, ComposerSurfaceContext } from "./composer/surface";
import { useAttachments } from "./composer/use-attachments";
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
	const [carryChips, setCarryChips] = useState(false);
	const hero = props.mode === "hero";
	const onDraftChange = useCallback(
		(text: string) => {
			setDraft(text);
			if (hero) {
				// The welcome surface may also hold chips; they ride the same flip.
				setCarryChips(true);
				setCarry(text);
				return;
			}
			setCarryChips(false);
			setCarry(prev => (prev !== "" && text === prev ? "" : prev));
		},
		[hero],
	);
	// Attachment intake lives here too: chips added on the welcome surface are
	// the same array the session skin sends, so a pre-session chip is not lost
	// on the flip. Staging stays mode-aware — the draft surface has no session
	// to upload into yet (`stageFiles: false`), the session surface does.
	const intake = useAttachments(props.rpc, { stageFiles: !hero });
	const handoff = {
		initialDraft: draft,
		onDraftChange,
		attachmentsApi: intake,
		...(hero ? {} : { carryDraft: carry, carryChips }),
	};
	const send = useCallback(
		(text: string, payload: ComposerSendPayload = {}) => {
			if (props.mode === "hero") {
				return props.onSubmit(text, {
					thinkingLevel: payload.thinkingLevel as never,
					modelId: payload.modelId,
					images: payload.images,
					displayContext: payload.displayContext as never,
					files: payload.files,
					videos: payload.videos,
					planMode: payload.planMode,
					goalMode: payload.goalMode,
					guidedGoal: payload.guidedGoal,
				});
			}
			return props.onSend(text, payload.images, payload.deliverAs, payload.displayContext as never, payload.videos);
		},
		[props],
	);
	const surface: ComposerSurface = {
		variant: hero ? "hero" : "session",
		intake,
		initialDraft: draft,
		onDraftChange,
		send,
		...(hero ? {} : { carryDraft: carry, carryChips }),
	};
	return (
		<ComposerSurfaceContext.Provider value={surface}>
			{hero ? <HeroComposer {...props} {...handoff} /> : <SessionComposer {...props} {...handoff} />}
		</ComposerSurfaceContext.Provider>
	);
}

// The compiled input-card artifact imports this module through the host table
// (EXTENSION_HOST_MODULES "composer"); register the same instance the shell
// uses so the seat and the fallback share one component module.
registerHostModule("composer", { Composer });
