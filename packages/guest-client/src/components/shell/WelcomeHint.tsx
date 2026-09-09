import { type ReactNode, useEffect, useState } from "react";
import { type TranslationKey, t } from "../../i18n/index.js";

/**
 * Empty-state greeting + rotating tip (absorbed from the gui WelcomeComposer).
 * Time-aware greeting uses seven hour brackets, each with its own tone; the
 * tip line cycles on a 6s timer and refreshes with a shimmer keyed re-render.
 */

/** Time-aware greeting (ZCode-style): seven brackets — 凌晨 / 清晨 / 早上 /
 * 中午 / 下午 / 晚上 / 深夜. */
function greeting(hour: number): string {
	if (hour < 5) return t("it is late, take care");
	if (hour < 8) return t("early morning");
	if (hour < 12) return t("good morning");
	if (hour < 14) return t("good noon");
	if (hour < 18) return t("good afternoon");
	if (hour < 22) return t("good evening");
	return t("it is late, take care");
}

/** Rotating tips shown under the greeting. Keys are translated at render
 *  time (t is locale-aware), so a locale switch updates the tip line. */
const TIP_KEYS: TranslationKey[] = [
	"try / for commands and @ for context",
	"ask the agent to explain a file with @",
	"approval cards appear when a tool needs your ok",
	"dictate with the mic button in the composer",
	"annotate images before sending them",
	"schedule idle-window tasks from the task center",
	"type /autoresearch to run experiments",
	"favorite models pin to the top of the model picker",
	"plan mode makes the agent outline before editing",
	"goal mode turns your next message into a goal",
	"paused sessions survive daemon restarts",
	"pick a preset mode for the new session",
	"customize the scrollbar skin in appearance settings",
] as const;

function nextTip(current: TranslationKey): TranslationKey {
	const pool = TIP_KEYS.filter(x => x !== current);
	return pool[Math.floor(Math.random() * pool.length)] ?? TIP_KEYS[0]!;
}

/** Rotating tip interval (ms). */
const TIP_INTERVAL_MS = 6000;

export function WelcomeHint(): ReactNode {
	const [tipKey, setTipKey] = useState<TranslationKey>(() => TIP_KEYS[Math.floor(Math.random() * TIP_KEYS.length)]!);

	useEffect(() => {
		const timer = setInterval(() => {
			setTipKey(current => nextTip(current));
		}, TIP_INTERVAL_MS);
		return () => clearInterval(timer);
	}, []);

	return (
		<div className="sh-welcome-hint">
			<p className="sh-welcome-greeting">{greeting(new Date().getHours())}</p>
			<p key={tipKey} className="sh-welcome-tip">
				{t(tipKey)}
			</p>
		</div>
	);
}
