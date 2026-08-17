import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { getTabsMapForTest } from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import * as logger from "@musepi/pi-utils/logger";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab evaluation", () => {
	// Launches real headless Chromium; CI cold start easily exceeds bun's 5s default.
	it("runs tab.evaluate in the page's main JavaScript world", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `main-world-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<script>globalThis.__ompMainWorld = 42</script>",
			});
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: "return await tab.evaluate(() => globalThis.__ompMainWorld);",
			});

			expect(result.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("clears request interception and held requests between runs, including thrown runs", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/held") return new Response("normal-held");
				if (pathname === "/mock") return new Response("normal-mock");
				return new Response("<title>Interception lifecycle</title>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const tool = new BrowserTool(makeSession());
		const name = `interception-lifecycle-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: `http://127.0.0.1:${server.port}/`,
			});
			let setupError: unknown;
			try {
				await tool.execute("run", {
					action: "run",
					name,
					code: `
						globalThis.__requestListenerBaseline = page.listenerCount("request");
						await page.setRequestInterception(true);
						page.on("request", request => void request.abort());
						throw new Error("setup failed");
					`,
				});
			} catch (error) {
				setupError = error;
			}
			expect(setupError).toBeInstanceOf(Error);
			expect(setupError).toHaveProperty("message", "setup failed");

			const afterThrow = await tool.execute("run", {
				action: "run",
				name,
				code: `
					return {
						clean: page.listenerCount("request") === globalThis.__requestListenerBaseline,
						body: await tab.evaluate(async () => await (await fetch("/mock")).text()),
					};
				`,
			});
			expect(afterThrow.content).toEqual([
				{ type: "text", text: '{\n  "clean": true,\n  "body": "normal-mock"\n}' },
			]);

			const intercepted = await tool.execute("run", {
				action: "run",
				name,
				code: `
					let heldSeen = false;
					await page.setRequestInterception(true);
					page.on("request", request => {
						const pathname = new URL(request.url()).pathname;
						if (pathname === "/held") {
							heldSeen = true;
							return;
						}
						if (pathname === "/mock") {
							void request.respond({ status: 200, body: "mocked" });
							return;
						}
						void request.continue();
					});
					await tab.evaluate(() => {
						globalThis.__heldFetch = fetch("/held").then(async response => await response.text());
					});
					await wait(() => heldSeen);
					return await tab.evaluate(async () => await (await fetch("/mock")).text());
				`,
			});
			expect(intercepted.content).toEqual([{ type: "text", text: "mocked" }]);

			const resumed = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const listeners = page.listenerCount("request");
					if (listeners !== globalThis.__requestListenerBaseline) {
						return { clean: false, listeners, baseline: globalThis.__requestListenerBaseline };
					}
					return {
						clean: true,
						values: await tab.evaluate(async () => [
							await globalThis.__heldFetch,
							await (await fetch("/mock")).text(),
						]),
					};
				`,
			});
			expect(resumed.content).toEqual([
				{
					type: "text",
					text: '{\n  "clean": true,\n  "values": [\n    "normal-held",\n    "normal-mock"\n  ]\n}',
				},
			]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
			server.stop(true);
		}
	}, 30_000);

	it("fires a once request handler exactly once and clears it between runs", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/mock") return new Response("normal-mock");
				return new Response("<title>Once interception</title>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const tool = new BrowserTool(makeSession());
		const name = `once-interception-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: `http://127.0.0.1:${server.port}/`,
			});
			const fired = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const baseline = page.listenerCount("request");
					globalThis.__requestListenerBaseline = baseline;
					await page.setRequestInterception(true);
					page.once("request", request => {
						if (new URL(request.url()).pathname === "/mock") {
							void request.respond({ status: 200, body: "mocked-once" });
							return;
						}
						void request.continue();
					});
					const body = await tab.evaluate(async () => await (await fetch("/mock")).text());
					// A once handler that fired must unregister from the emitter, not just the tracker.
					return { body, leaked: page.listenerCount("request") - baseline };
				`,
			});
			expect(fired.content).toEqual([{ type: "text", text: '{\n  "body": "mocked-once",\n  "leaked": 0\n}' }]);

			const resumed = await tool.execute("run", {
				action: "run",
				name,
				code: `
					return {
						clean: page.listenerCount("request") === globalThis.__requestListenerBaseline,
						body: await tab.evaluate(async () => await (await fetch("/mock")).text()),
					};
				`,
			});
			expect(resumed.content).toEqual([{ type: "text", text: '{\n  "clean": true,\n  "body": "normal-mock"\n}' }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
			server.stop(true);
		}
	}, 30_000);

	it("keeps the tab worker alive after an unhandled waitForResponse timeout descendant", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `response-timeout-descendant-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<h1>ready</h1>",
			});
			const tabSession = getTabsMapForTest().get(name);
			if (tabSession?.backend !== "worker") throw new Error("Worker tab was not created");
			expect(tabSession.worker.mode).toBe("worker");
			const result = await tool.execute("run", {
				action: "run",
				name,
				timeout: 2,
				// Real worker timers are intentional: the rejection must cross an
				// unhandledRejection turn while the browser run remains active.
				code: `
					void tab.waitForResponse("/never", { timeout: 10 }).then(() => undefined);
					await Bun.sleep(50);
					return "survived timeout";
				`,
			});
			expect(result.content).toEqual([{ type: "text", text: "survived timeout" }]);

			const followup = await tool.execute("run", {
				action: "run",
				name,
				code: "return 42;",
			});
			expect(followup.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("fails floated user continuations without killing the tab worker", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `continuation-rejection-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<h1>ready</h1>",
			});
			let failure = "";
			try {
				await tool.execute("run", {
					action: "run",
					name,
					timeout: 2,
					code: `
						void tab.title().then(() => {
							throw new Error("continuation failed");
						});
						await Bun.sleep(50);
						return "incorrect success";
					`,
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect(failure).toContain("Unhandled rejection (missing await?): continuation failed");

			let rethrowFailure = "";
			try {
				await tool.execute("run", {
					action: "run",
					name,
					timeout: 2,
					code: `
						void tab.waitForResponse("/never", { timeout: 10 }).catch(reason => {
							throw reason;
						});
						await Bun.sleep(50);
						return "incorrect success";
					`,
				});
			} catch (error) {
				rethrowFailure = error instanceof Error ? error.message : String(error);
			}
			expect(rethrowFailure).toContain(
				"Unhandled rejection (missing await?): tab.waitForResponse() timed out after 10ms",
			);

			const followup = await tool.execute("run", {
				action: "run",
				name,
				code: "return 42;",
			});
			expect(followup.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("fails a browser error rethrown through a native promise combinator", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `combinator-rejection-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<h1>ready</h1>",
			});
			let failure = "";
			try {
				await tool.execute("run", {
					action: "run",
					name,
					timeout: 2,
					code: `
						void Promise.all([
							tab.waitForResponse("/never", { timeout: 10 }),
						]).catch(reason => {
							throw reason;
						});
						await Bun.sleep(50);
						return "incorrect success";
					`,
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect(failure).toContain("Unhandled rejection (missing await?): tab.waitForResponse() timed out after 10ms");

			const followup = await tool.execute("run", {
				action: "run",
				name,
				code: "return 42;",
			});
			expect(followup.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("restores promise tracking after evaluated code freezes Promise", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `frozen-promise-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<h1>ready</h1>",
			});
			const frozen = await tool.execute("run", {
				action: "run",
				name,
				code: `
					Object.freeze(Promise);
					return Object.isFrozen(Promise);
				`,
			});
			expect(frozen.content).toEqual([{ type: "text", text: "true" }]);

			const followup = await tool.execute("run", {
				action: "run",
				name,
				code: "return (await Promise.all([42]))[0];",
			});
			expect(followup.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("aborts the run facade before draining floated continuations", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `drain-abort-${process.pid}`;
		const url = "data:text/html,<title>original</title><h1>ready</h1>";

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url,
			});
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: `
					page.title = async () => {
						await Bun.sleep(0);
						return "ready";
					};
					void tab.title().then(() => tab.goto("data:text/html,<title>late</title>"));
					return "completed";
				`,
			});
			expect(result.content).toEqual([{ type: "text", text: "completed" }]);

			await Bun.sleep(100);
			const followup = await tool.execute("run", {
				action: "run",
				name,
				code: "return tab.url();",
			});
			expect(followup.content).toEqual([{ type: "text", text: url }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("folds a user continuation rejection that settles during cleanup", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `cleanup-continuation-rejection-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<h1>ready</h1>",
			});
			let failure = "";
			try {
				await tool.execute("run", {
					action: "run",
					name,
					code: `
						await page.setRequestInterception(true);
						page.setRequestInterception = async () => {
							await Bun.sleep(50);
						};
						const continuationStarted = Promise.withResolvers();
						void tab.title().then(async () => {
							continuationStarted.resolve();
							await Bun.sleep(10);
							throw new Error("cleanup continuation failed");
						});
						await continuationStarted.promise;
						return "incorrect success";
					`,
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect(failure).toContain("Unhandled rejection (missing await?): cleanup continuation failed");
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("logs a user continuation rejection after its browser run ends", async () => {
		const warningLogged = Promise.withResolvers<void>();
		const warn = vi.spyOn(logger, "warn").mockImplementation(message => {
			if (message === "Unhandled rejection after browser run ended") warningLogged.resolve();
		});
		const tool = new BrowserTool(makeSession());
		const name = `late-continuation-rejection-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<h1>ready</h1>",
			});
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const continuationStarted = Promise.withResolvers();
					void tab.title().then(async () => {
						continuationStarted.resolve();
						await Bun.sleep(50);
						throw new Error("late continuation failed");
					});
					await continuationStarted.promise;
					return "completed";
				`,
			});
			expect(result.content).toEqual([{ type: "text", text: "completed" }]);

			await warningLogged.promise;
			expect(warn).toHaveBeenCalledWith("Unhandled rejection after browser run ended", {
				runId: expect.any(String),
				error: "late continuation failed",
			});
		} finally {
			warn.mockRestore();
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("observes floating raw page promises when the target closes", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `target-close-${process.pid}`;
		const url = `data:text/html,<h1>ready</h1>#${name}`;

		try {
			await tool.execute("open", { action: "open", name, url });
			const tabSession = getTabsMapForTest().get(name);
			if (tabSession?.backend !== "worker") throw new Error("Worker tab was not created");
			const pages = await tabSession.browser.browser.pages();
			const targetPage = pages.find(page => page.url() === url);
			if (!targetPage) throw new Error(`Target page was not found for ${url}`);

			const started = targetPage.waitForFunction("document.documentElement.dataset.floating === 'true'", {
				polling: "mutation",
			});
			const run = tool.execute("run", {
				action: "run",
				name,
				code: "page.evaluate(() => { document.documentElement.dataset.floating = 'true'; return Promise.withResolvers().promise; }); try { await tab.waitForSelector('#never'); } catch {} return 'survived';",
			});
			const startedHandle = await started;
			await startedHandle.dispose();
			await targetPage.close();

			const result = await run;
			expect(result.content).toEqual([{ type: "text", text: "survived" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);
});
