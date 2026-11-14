/**
 * CDP driver for the settings-shell repro/verification (bun native WS).
 * Usage: bun scripts/cdp-settings-probe.ts "<js expression>"  — evaluates in
 * the GUI page target. With no args, prints the target list.
 */
const base = process.env.CDP_PORT ? `http://127.0.0.1:${process.env.CDP_PORT}` : "http://127.0.0.1:9222";

async function main(): Promise<void> {
	const expr = process.argv[2];
	const list = (await (await fetch(`${base}/json/list`)).json()) as {
		id: string;
		type: string;
		title: string;
		url: string;
		webSocketDebuggerUrl: string;
	}[];
	const pages = list.filter(t => t.type === "page");
	if (!expr) {
		console.log(
			JSON.stringify(
				pages.map(p => ({ title: p.title, url: p.url })),
				null,
				2,
			),
		);
		return;
	}
	// The dev renderer is the vite-served page; the tray menu is a file:// page.
	const page = pages.find(p => p.url.includes("5173")) ?? pages[0];
	if (!page) throw new Error("no page target");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise<void>((res, rej) => {
		ws.onopen = () => res();
		ws.onerror = () => rej(new Error("ws error"));
	});
	let seq = 0;
	const result = await new Promise<string>((res, rej) => {
		ws.onmessage = ev => {
			const msg = JSON.parse(String(ev.data)) as {
				id?: number;
				result?: {
					result?: { value?: unknown };
					exceptionDetails?: { text: string; exception?: { description?: string } };
				};
			};
			if (msg.id !== seq) return;
			if (msg.result?.exceptionDetails) {
				rej(new Error(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text));
				return;
			}
			res(String(msg.result?.result?.value ?? "undefined"));
		};
		seq = 1;
		ws.send(
			JSON.stringify({
				id: 1,
				method: "Runtime.evaluate",
				params: { expression: expr, returnByValue: true, awaitPromise: true },
			}),
		);
		setTimeout(() => rej(new Error("cdp timeout")), Number(process.env.CDP_TIMEOUT_MS ?? 20000));
	});
	console.log(result);
	ws.close();
}

await main();
