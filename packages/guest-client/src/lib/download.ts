/**
 * File download — the single implementation shared by the transcript's
 * markdown table/SVG exports and the widget card's "下载到本地 / 下载为图片".
 *
 * A blob object URL plus a synthetic `<a download>` click works in every host
 * guest-client runs in (desktop renderer, plain browser, mobile shell): the
 * desktop shell routes it through Chromium's own download path, the browser
 * builds the same flow natively. No host capability is needed, so the action
 * is available everywhere rather than behind a desktop-only bridge.
 */

export function downloadBlob(name: string, content: string | Blob, mime?: string): void {
	const blob =
		typeof content === "string" ? new Blob([content], { type: mime ?? "application/octet-stream" }) : content;
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}
