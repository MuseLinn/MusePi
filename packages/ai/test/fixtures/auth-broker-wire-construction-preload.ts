import { spyOn } from "bun:test";
import { type } from "arktype";

declare global {
	var __authBrokerWireConstructionCount: number;
}

globalThis.__authBrokerWireConstructionCount = 0;
const originalEnumerated = type.enumerated;
spyOn(type, "enumerated").mockImplementation((...values) => {
	if (values.length === 1 && values[0] === "__remote__") {
		globalThis.__authBrokerWireConstructionCount += 1;
	}
	return originalEnumerated(...values);
});
