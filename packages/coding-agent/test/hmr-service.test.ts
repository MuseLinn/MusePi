/**
 * The HMR plugin provides the process-wide `hmr` service; this test covers the
 * service contract itself and the `ctx.hmr` resolution that reads it back.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHmrService, type HmrRestartRequirement } from "../src/extensibility/plugins/hmr/service";
import {
	clearHostServices,
	getHostService,
	provideHostService,
} from "../src/extensibility/plugins/runtime/host-services";

afterEach(() => {
	clearHostServices();
});

describe("hmr service", () => {
	it("notifies subscribers and disposes individually", async () => {
		const service = createHmrService([], 0);
		const seen: string[] = [];
		const dispose = service.onChange(change => {
			seen.push(`${change.trigger}:${change.paths.length}`);
		});

		await service.reload();
		expect(seen).toEqual(["manual:0"]);

		dispose();
		await service.reload();
		expect(seen).toEqual(["manual:0"]);

		await service.dispose();
		expect(service.enabled).toBe(false);
	});

	it("isolates a throwing listener from its siblings", async () => {
		const service = createHmrService([], 0);
		let second = 0;
		service.onChange(() => {
			throw new Error("boom");
		});
		service.onChange(() => {
			second += 1;
		});

		await service.reload();
		expect(second).toBe(1);
		await service.dispose();
	});

	it("hands a restart request to the host and keeps it outstanding", async () => {
		const service = createHmrService([], 0);
		const seen: HmrRestartRequirement[] = [];
		const dispose = service.onRestartRequired(requirement => {
			seen.push(requirement);
		});

		const requirement = { file: "/project/src/host.ts", reason: "host module changed" };
		service.requestRestart(requirement);

		expect(seen).toEqual([requirement]);
		expect(service.restartRequired).toEqual(requirement);

		dispose();
		service.requestRestart({ reason: "another change" });
		expect(seen).toHaveLength(1);
		await service.dispose();
	});

	it("publishes hmr/change and hmr/reload for one batch", async () => {
		const service = createHmrService([], 0);
		const seen: string[] = [];
		service.on("hmr/change", () => {
			seen.push("change");
		});
		service.on("hmr/reload", () => {
			seen.push("reload");
		});

		await service.reload();
		expect(seen).toEqual(["change", "reload"]);
		await service.dispose();
	});

	it("dispatches through Cordis, so prepend orders a listener first", async () => {
		const service = createHmrService([], 0);
		const seen: string[] = [];
		service.on("hmr/change", () => {
			seen.push("normal");
		});
		service.on(
			"hmr/change",
			() => {
				seen.push("prepended");
			},
			{ prepend: true },
		);

		await service.reload();
		expect(seen).toEqual(["prepended", "normal"]);
		await service.dispose();
	});

	it("serializes transactions so a reload never interleaves an install", async () => {
		const service = createHmrService([], 0);
		const log: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});

		const first = service.runExclusive(async () => {
			log.push("first:start");
			await gate;
			log.push("first:end");
		});
		const second = service.runExclusive(() => {
			log.push("second");
		});

		release();
		await Promise.all([first, second]);
		expect(log).toEqual(["first:start", "first:end", "second"]);
		await service.dispose();
	});

	it("answers linked-entry and importer-chain queries once a graph is attached", async () => {
		const service = createHmrService([], 0);
		const detach = service.attachGraph({
			linkedEntries: file => (file.endsWith("/leaf.ts") ? ["/plugin/index.ts"] : []),
			outerStack: file =>
				file.endsWith("/leaf.ts") ? ["/plugin/index.ts", "/plugin/mid.ts", "/plugin/leaf.ts"] : [],
		});

		expect(service.getLinked("/plugin/leaf.ts")).toEqual(["/plugin/index.ts"]);
		expect(service.getOuterStack("/plugin/leaf.ts")).toEqual([
			"/plugin/index.ts",
			"/plugin/mid.ts",
			"/plugin/leaf.ts",
		]);
		expect(service.getLinked("/elsewhere.ts")).toEqual([]);

		detach();
		expect(service.getLinked("/plugin/leaf.ts")).toEqual([]);
		await service.dispose();
	});

	it("honors base/root/ignored/debounce from the plugin config", async () => {
		const { apply } = await import("../src/bundled-plugins/hmr/index");
		const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const path = await import("node:path");
		const dir = await mkdtemp(path.join(tmpdir(), "musepi-hmr-config-"));
		await mkdir(path.join(dir, "watched"));
		let cleanup: (() => void) | undefined;
		try {
			const result = await apply(
				{
					cwd: dir,
					effect: (fn: () => void) => {
						cleanup = fn;
						return () => {};
					},
				} as never,
				{ base: dir, root: "watched", ignored: "**/tmp/**", debounce: 5 },
			);
			expect(result.hmr.roots).toEqual([path.join(dir, "watched")]);
			expect(result.hmr.enabled).toBe(true);
		} finally {
			cleanup?.();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports no watcher for an empty root set", () => {
		const service = createHmrService([]);
		expect(service.enabled).toBe(false);
	});
});

describe("ctx.hmr", () => {
	it("reads the provided host service", async () => {
		const { ExtensionRuntime, loadExtensionFromFactory } = await import("../src/extensibility/extensions/loader");
		const { EventBus } = await import("../src/utils/event-bus");
		const service = createHmrService([], 0);
		const disposeService = provideHostService("hmr", service);

		let enabled: boolean | undefined;
		let off: (() => void) | undefined;
		await loadExtensionFromFactory(
			ctx => {
				enabled = ctx.hmr.enabled;
				off = ctx.hmr.onChange(() => {});
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"<hmr-test>",
		);

		expect(enabled).toBe(false); // empty roots: service is not watching
		expect(typeof off).toBe("function");
		off?.();
		disposeService();
		await service.dispose();
	});

	it("hands back a no-op surface when no host provided the service", async () => {
		const { ExtensionRuntime, loadExtensionFromFactory } = await import("../src/extensibility/extensions/loader");
		const { EventBus } = await import("../src/utils/event-bus");
		let enabled: boolean | undefined;
		let off: (() => void) | undefined;
		await loadExtensionFromFactory(
			ctx => {
				enabled = ctx.hmr.enabled;
				off = ctx.hmr.onChange(() => {});
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"<hmr-test>",
		);
		expect(enabled).toBe(false);
		expect(typeof off).toBe("function");
	});
});

describe("restart request ownership", () => {
	it("retains distinct requests until acknowledged and clears them on dispose", async () => {
		const service = createHmrService([], 0);
		const first = { file: "/project/a.ts", reason: "first" };
		const second = { file: "/project/b.ts", reason: "second" };
		service.requestRestart(first);
		service.requestRestart(second);
		service.requestRestart(first);
		expect(service.restartRequirements).toEqual([first, second]);
		expect(service.restartRequired).toEqual(first);

		service.acknowledgeRestart(first);
		expect(service.restartRequirements).toEqual([second]);
		expect(service.restartRequired).toEqual(second);

		await service.dispose();
		expect(service.restartRequirements).toEqual([]);
		expect(service.restartRequired).toBeNull();
	});
});

describe("host service registry", () => {
	it("rejects a duplicate name without replacing the incumbent", () => {
		const incumbent = { owner: "incumbent" };
		const rejected = { owner: "rejected" };
		const dispose = provideHostService("shared", incumbent);
		expect(() => provideHostService("shared", rejected)).toThrow("already provided");
		expect(getHostService("shared")).toBe(incumbent);
		dispose();
	});
});
