import "./happy-dom-shim";
import { beforeEach, describe, expect, test } from "bun:test";
import { grantRemoteAccessConsent, hasRemoteAccessConsent } from "../src/lib/remote-access-consent";

beforeEach(() => localStorage.clear());

describe("remote access consent", () => {
	test("requires an explicit grant for the current disclaimer version", () => {
		expect(hasRemoteAccessConsent()).toBe(false);
		expect(localStorage.getItem("musepi-gui-remote-access-consent")).toBeNull();
	});

	test("persists a grant that can be read on a later launch", () => {
		grantRemoteAccessConsent();
		expect(hasRemoteAccessConsent()).toBe(true);
		expect(localStorage.getItem("musepi-gui-remote-access-consent")).toBe("1");
	});

	test("rejects missing, legacy, and malformed consent values", () => {
		for (const value of ["0", "false", "2", "granted", "{broken"]) {
			localStorage.setItem("musepi-gui-remote-access-consent", value);
			expect(hasRemoteAccessConsent()).toBe(false);
		}
	});
});
