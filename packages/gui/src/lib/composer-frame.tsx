import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { BorderBeam } from "../vendor/border-beam";
import { Icon } from "../vendor/oc-icons";

/**
 * Shared composer container (welcome + in-session parity): one frame shell
 * renders the textarea, the attachment chips and the footer row for BOTH
 * scenes, so the welcome→session transition can morph one container into
 * the other (FLIP in ChatView) instead of cross-fading two different trees.
 *
 * `flipAnchor` marks the frame for the morph measurement; the incoming
 * frame animates from the outgoing frame's rect via gui-flip-morph.
 */
export function ComposerFrame({
	className = "",
	children,
	attachments,
	onRemoveAttachment,
	statusRow,
	footerLeft,
	footerRight,
	hero = false,
	heroActive = false,
	enhancing = false,
	flipAnchor,
	pet = null,
}: {
	className?: string;
	/** Textarea + any floating menus the composer needs (absolute). */
	children: ReactNode;
	attachments: { id: number; dataUrl: string; mimeType: string; name: string }[];
	onRemoveAttachment(id: number): void;
	/** Chips row above the footer (goal/plan modes) — session only. */
	statusRow?: ReactNode;
	footerLeft: ReactNode;
	footerRight: ReactNode;
	/** Border-beam hero glow (welcome scene). */
	hero?: boolean;
	/** Drive the beam's active state — focus-triggered: the beam fades in
	 * while the composer has focus and fades out on blur (never a static
	 * box). Only meaningful with hero. */
	heroActive?: boolean;
	/** data-enhancing marker (session). */
	enhancing?: boolean;
	flipAnchor?: "welcome" | "session";
	/** Companion pet, docked outside the input's top edge, right-aligned
	 * (input mode). Rendered absolutely against the frame so welcome and
	 * session scenes share one placement. */
	pet?: ReactNode;
}): ReactNode {
	const frame = (
		<div
			className={`${className} gui-composer-frame`}
			data-enhancing={enhancing || undefined}
			// data-flip-anchor rides on the hero wrapper (BorderBeam) when
			// present — the morph must transform the element that carries
			// the shadow + beam, not the frame inside it.
			data-flip-anchor={flipAnchor && !hero ? flipAnchor : undefined}
		>
			{pet && <div className="gui-composer-pet">{pet}</div>}
			{children}
			{attachments.length > 0 && (
				<div className="gui-attach-row px-4 pb-2">
					{attachments.map(a => (
						<div key={a.id} className="gui-attach-chip">
							<img src={a.dataUrl} alt={a.name} className="gui-attach-thumb" />
							<button
								type="button"
								className="gui-attach-x"
								aria-label={t("remove attachment")}
								onClick={() => onRemoveAttachment(a.id)}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			)}
			{statusRow}
			<div className="gui-composer-row px-4 pb-3">
				<div className="gui-composer-left">{footerLeft}</div>
				<div className="gui-composer-right">{footerRight}</div>
			</div>
		</div>
	);
	if (hero)
		return (
			<BorderBeam
				className={`gui-border-beam${pet ? " gui-border-beam--pet" : ""}`}
				// The scene-switch FLIP morph transforms this wrapper (not
				// the frame): the shadow and beam stroke live on the wrapper,
				// so the whole card — card, shadow, beam — morphs together.
				data-flip-anchor={flipAnchor}
				size="md"
				colorVariant="ocean"
				theme="auto"
				// Same radius as the frame (14px): the beam stroke, the
				// wrapper-carried shadow and the input card all share one
				// corner so nothing looks misaligned.
				borderRadius={14}
				active={heroActive}
			>
				{frame}
			</BorderBeam>
		);
	return frame;
}
