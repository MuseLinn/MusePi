import { t } from "@musepi/collab-web";
import type { ReactNode, RefObject } from "react";
import { useEffect, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Jump-to-bottom button (openchamber ScrollToBottomButton parity): a
 * floating round button over the composer edge, visible only while the
 * transcript is scrolled away from the bottom. Also maintains the
 * transcript's data-top-scroll / data-bottom-scroll attributes, which
 * switch the mask-image gradient fades on and off (real content fades,
 * applied only when the content overflows).
 */
export function JumpToBottomButton({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }): ReactNode {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		const measure = (): void => {
			const el = rootRef.current;
			if (!el) return;
			const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 64;
			setVisible(!nearBottom);
			// Scroll-shadow state (openchamber ScrollShadow parity): the
			// fade mask only engages while the content overflows.
			el.dataset.topScroll = el.scrollTop > 8 ? "true" : "false";
			el.dataset.bottomScroll = el.scrollTop + el.clientHeight < el.scrollHeight - 8 ? "true" : "false";
		};

		root.addEventListener("scroll", measure, { passive: true });
		const ro = new ResizeObserver(measure);
		ro.observe(root);
		// Content growth (streaming) changes scrollHeight without a scroll
		// event — re-measure on child mutations, RAF-throttled.
		let raf = 0;
		const mo = new MutationObserver(() => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(measure);
		});
		mo.observe(root, { childList: true, subtree: true });
		const onVis = (): void => {
			if (document.visibilityState === "visible") measure();
		};
		document.addEventListener("visibilitychange", onVis);
		measure();
		return () => {
			root.removeEventListener("scroll", measure);
			ro.disconnect();
			mo.disconnect();
			cancelAnimationFrame(raf);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rootRef]);

	return (
		<button
			type="button"
			className={`gui-jump-bottom${visible ? " gui-jump-bottom--visible" : ""}`}
			aria-label={t("jump to bottom")}
			title={t("jump to bottom")}
			tabIndex={visible ? 0 : -1}
			onClick={() => {
				const el = rootRef.current;
				if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
			}}
		>
			<Icon name="arrow-down" className="h-4 w-4" />
		</button>
	);
}
