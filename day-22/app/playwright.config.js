import { defineConfig } from "@playwright/test";

// One local Hardhat node + the built Next.js app. Tests run one at a time
// because they share the chain (each test snapshots and reverts it).
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.js",
  use: { baseURL: "http://127.0.0.1:3000", viewport: { width: 1100, height: 900 } },
  webServer: [
    { command: "npx hardhat node", cwd: "..", port: 8545, reuseExistingServer: true, timeout: 120_000 },
    { command: "npm run build && npm run start", port: 3000, reuseExistingServer: true, timeout: 240_000,
      env: { NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_TX_TIMEOUT_MS: "6000" } }, // short timeout for the "dropped" test
  ],
});
