import { isBunTestRuntime } from "@musepi/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
