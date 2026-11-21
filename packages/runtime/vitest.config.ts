import { defineConfig } from "vitest/config";

// Each test file starts its own MongoDB. Starting several at once can time out
// on a busy Windows machine, so files run one after another.
export default defineConfig({ test: { fileParallelism: false } });
