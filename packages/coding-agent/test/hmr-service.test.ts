/**
 * The HMR plugin provides the process-wide `hmr` service; this test covers the
 * service contract itself and the `ctx.hmr` resolution that reads it back.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHmrService } from "../src/extensibility/plugins/hmr/service";
import { clearHostServices, provideHostService } from "../src/extensibility/plugins/runtime/host-services";

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
