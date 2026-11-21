/** Starts the fake app APIs for browser tests: `tsx fake-apis-cli.ts <port>`. */
import { startFakeApis } from "./fake-apis";

const port = Number(process.argv[2] ?? 3199);
const fake = await startFakeApis(port);
console.info(`[fake-apis] listening on ${fake.url}`);
