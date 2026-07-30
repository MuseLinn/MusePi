import { spyOn } from "bun:test";
import * as arktype from "arktype";

declare global {
	var __computerCoordinateSchemaConstructionCount: number;
}

const coordinateDefinition = "0 <= number.integer <= 2147483647";
globalThis.__computerCoordinateSchemaConstructionCount = 0;
const originalType = arktype.type;
const countedType = ((...args: unknown[]) => {
	if (args[0] === coordinateDefinition) {
		globalThis.__computerCoordinateSchemaConstructionCount += 1;
	}
	return Reflect.apply(originalType, undefined, args);
}) as typeof originalType;
Object.assign(countedType, originalType);
const typeSpy = spyOn(arktype, "type").mockImplementation(countedType);
Object.assign(typeSpy, originalType);
