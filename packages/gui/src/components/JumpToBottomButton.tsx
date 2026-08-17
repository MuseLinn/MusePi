import { t } from "@musepi/collab-web";
import type { ReactNode, RefObject } from "react";
import { useState } from "react";
import { tapFeedback } from "../lib/haptic";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon } from "../vendor/oc-icons";

/**
 * Jump-to-bottom button (openchamber ScrollToBottomButton parity): a
 * floating round button over the composer edge, visible only while the
 * transcript is scrolled away from the bottom. The transcript's
 * data-top-scroll / data-bottom-scroll attributes (switch the mask-image
 * gradient fades on and off) are maintained by the shared useScrollShadow
 * hook.
 */
export function JumpToBottomButton({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }): ReactNode {
	const [visible, setVisible] = useState(false);

	// Scroll-shadow state (openchamber ScrollShadow parity): the fade mask
	// only engages while the content overflows; the button shows while the
	// transcript is away from the bottom (same scroll pass).
	useScrollShadow(rootRef, el => {
		setVisible(el.scrollTop + el.clientHeight < el.scrollHeight - 64);
	});

	return (
		<button
			type="button"
			className={`gui-jump-bottom${visible ? " gui-jump-bottom--visible" : ""}`}
			aria-label={t("jump to bottom")}
			data-tip={t("jump to bottom")}
			tabIndex={visible ? 0 : -1}
			onClick={() => {
				tapFeedback();
				const el = rootRef.current;
				if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
			}}
		>
			<Icon name="arrow-down" className="h-4 w-4" />
		</button>
	);
}
