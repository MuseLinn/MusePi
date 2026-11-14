import "@aora-bot/react/styles.css";
import { agentColor, agentFace, agentShape, CharacterMark } from "@aora-bot/react";
import type { ReactNode } from "react";
import type { AgentSignals } from "../lib/agent-signals";
import { aoraStateFromSignals } from "../lib/aora-state";

export interface AoraAvatarProps {
	signals?: AgentSignals;
	seed?: string;
	size: number;
	still?: boolean;
	className?: string;
}

/**
 * Aora character in a compact avatar slot. The shared signals resolve to one
 * of Aora's states for the avatar surface; the seed fixes the body so the same
 * session keeps the same character.
 */
export function AoraAvatar({ signals, seed = "musepi", size, still, className }: AoraAvatarProps): ReactNode {
	const state = aoraStateFromSignals(signals ?? {}, "avatar");
	const agent = { id: seed };
	return (
		<span
			className={className ? `gui-aora-avatar ${className}` : "gui-aora-avatar"}
			data-aora-state={state}
			style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size }}
		>
			<CharacterMark
				shape={agentShape(agent)}
				color={agentColor(agent)}
				face={agentFace(agent)}
				state={state}
				sizePx={size}
				seed={seed}
				autoPause
				paused={still}
				antics={false}
			/>
		</span>
	);
}
