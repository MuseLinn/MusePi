import { X } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";

/** ZCode 引用回复 / Cmd+L 追加引用: quoted texts render as cards above the
 * input (not raw `> ` text pasted into the box). Cards stay until the
 * message is sent or closed individually. */
export function QuoteCards({ quotes, onRemove }: { quotes: string[]; onRemove(index: number): void }): ReactNode {
	return (
		<>
			{quotes.map((q, i) => (
				<div className="gui-quote-card" key={`${i}-${q.slice(0, 32)}`}>
					<div className="gui-quote-text">{q}</div>
					<button
						type="button"
						className="gui-quote-close"
						onClick={() => onRemove(i)}
						title={t("remove quote")}
						aria-label={t("remove quote")}
					>
						<X size={12} />
					</button>
				</div>
			))}
		</>
	);
}
