import { defineConfig, devices } from "@playwright/test";

// e2e tests render the Ink TUI in a real browser via the wterm harness. Each
// test spawns the launcher in a PTY against a fully mocked environment (see
// e2e/harness), so the suite is hermetic: no Azure DevOps, no real tmux server,
// no git repos, no network.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The suite drives a real Ink TUI through a PTY and reads it back from a
  // browser terminal, so every step depends on keystroke→render timing. Under
  // CPU contention a keystroke can land before React commits the prior render and
  // act on stale cursor state; a fresh retry resets the race. Retries cover that
  // timing fragility (not logic) — every test passes deterministically in
  // isolation. Keep workers low so tests don't starve each other for CPU.
  retries: 2,
  workers: process.env.CI ? 2 : 1,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: "./e2e/.artifacts",
  use: {
    headless: true,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
