import { defineConfig } from "vitest/config";

// Each test file starts its own MongoDB, which can take a while on a busy
// Windows machine: files run one after another, with time for start-up.
export default defineConfig({ test: { fileParallelism: false, hookTimeout: 90_000 } });
