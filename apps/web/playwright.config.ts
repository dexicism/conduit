import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;
const FAKE_APIS_PORT = 3199;
const FAKE_APIS_URL = `http://127.0.0.1:${FAKE_APIS_PORT}`;

// Requires the dev database: `npm run db` from the repo root.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // sign-in codes are rate limited per IP; keep runs deterministic
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  webServer: [
    {
      // Stand-in for Telegram, Slack and Google (OAuth, Gmail, Sheets). App calls are routed here.
      command: `npx tsx ../../packages/runtime/src/testing/fake-apis-cli.ts ${FAKE_APIS_PORT}`,
      url: `${FAKE_APIS_URL}/__calls`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
    command: `npx next dev --port ${PORT}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      BETTER_AUTH_URL: baseURL,
      // The e2e suite covers webhook delivery; polling is covered by the runtime tests.
      TELEGRAM_MODE: "webhook",
      MONGODB_DB: "conduit_e2e",
      OUTBOX_PATH: ".data/outbox-e2e.jsonl",
      // HTTP steps in tests call this app on localhost.
      HTTP_ALLOW_PRIVATE_NETWORK: "1",
      CONDUIT_WORKER: "inprocess",
      // Deterministic rule-based model: exercises every AI code path without an API key or cost.
      AI_PROVIDER: "fake",
      // No real WhatsApp connections from tests.
      WHATSAPP_WEB: "0",
      // ...and no backups of the test database.
      BACKUP: "0",
      CONDUIT_FAKE_APIS_URL: FAKE_APIS_URL,
      CONDUIT_ENCRYPTION_KEY: "v1:ZTJlLW9ubHktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXM=",
      CONNECT_GOOGLE_CLIENT_ID: "fake-google-client-id",
      CONNECT_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    },
    },
  ],
});
