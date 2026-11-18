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
import type { ComponentProps, ReactNode } from "react";
import { registerHostModule } from "../lib/host-modules";
import { HeroComposer } from "./HeroComposer";
import { SessionComposer, type SessionComposerProps } from "./SessionComposer";

export type HeroComposerProps = ComponentProps<typeof HeroComposer>;

export type ComposerProps = ({ mode?: "session" } & SessionComposerProps) | ({ mode: "hero" } & HeroComposerProps);

export function Composer(props: ComposerProps): ReactNode {
	return props.mode === "hero" ? <HeroComposer {...props} /> : <SessionComposer {...props} />;
}

// The compiled input-card artifact imports this module through the host table
// (EXTENSION_HOST_MODULES "composer"); register the same instance the shell
// uses so the seat and the fallback share one component module.
registerHostModule("composer", { Composer });
