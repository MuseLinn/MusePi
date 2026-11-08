/**
 * The HMR watcher is one process-wide service; hosts react to its batches on
 * their own terms, and plugins subscribe through `ctx.hmr`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { getHmrService, startHmrService, stopHmrService } from "../src/extensibility/plugins/hmr/service";
import { EventBus } from "../src/utils/event-bus";

afterEach(async () => {
	await stopHmrService();
});

describe("hmr service", () => {
	it("notifies subscribers and disposes individually", async () => {
		const service = startHmrService({ roots: [] });
		const seen: string[] = [];
		const dispose = service.onChange(change => {
			seen.push(`${change.trigger}:${change.paths.length}`);
		});

		await service.reload();
		expect(seen).toEqual(["manual:0"]);

		dispose();
		await service.reload();
		expect(seen).toEqual(["manual:0"]);

		await stopHmrService();
		expect(getHmrService()).toBeNull();
		expect(service.enabled).toBe(false);
	});

	it("isolates a throwing listener from its siblings", async () => {
		const service = startHmrService({ roots: [] });
		let second = 0;
		service.onChange(() => {
			throw new Error("boom");
		});
		service.onChange(() => {
			second += 1;
		});

		await service.reload();
		expect(second).toBe(1);
	});

	it("exposes the running service to plugins as ctx.hmr", async () => {
		startHmrService({ roots: [] });
		let enabled: boolean | undefined;
		let dispose: (() => void) | undefined;

		await loadExtensionFromFactory(
			ctx => {
				enabled = ctx.hmr.enabled;
				dispose = ctx.hmr.onChange(() => {});
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"<hmr-test>",
		);

		expect(enabled).toBe(true);
		expect(typeof dispose).toBe("function");
	});

	it("reports a disabled surface when no host started a watcher", async () => {
		let enabled: boolean | undefined;
		let dispose: (() => void) | undefined;
		await loadExtensionFromFactory(
			ctx => {
				enabled = ctx.hmr.enabled;
				dispose = ctx.hmr.onChange(() => {});
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"<hmr-test>",
		);
		expect(enabled).toBe(false);
		expect(typeof dispose).toBe("function");
	});
});
