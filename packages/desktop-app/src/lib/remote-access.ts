export function isCloudflaredMissing(error: string): boolean {
	return /cloudflared\s+is\s+not\s+installed/i.test(error);
}

export function channelStateText(
	state: string,
	detail: string | undefined,
): "connected" | "connecting" | "waiting" | "detail" | "off" {
	if (state === "connected") return "connected";
	if (state === "connecting") return "connecting";
	if (state === "waiting_scan") return "waiting";
	return detail ? "detail" : "off";
}
