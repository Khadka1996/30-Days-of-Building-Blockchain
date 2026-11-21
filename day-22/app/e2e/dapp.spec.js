import { test, expect } from "@playwright/test";
import { installWallet, ACCOUNT } from "./wallet.js";
import { rpc } from "./rpc.js";

// Every test starts from the same chain state and leaves no trace.
let snapshot;
test.beforeEach(async () => { snapshot = await rpc("evm_snapshot"); });
test.afterEach(async () => { await rpc("evm_revert", [snapshot]); });

async function connect(page, opts) {
  await installWallet(page, opts);
  await page.goto("/");
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("account")).toHaveText(`${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)}`);
}
const sentCount = (page) => page.evaluate(() => window.__wallet.sent.length);
const status = (page, panel) => page.locator(`section[aria-labelledby="${panel}"] [data-testid="tx-status"]`);

test("happy path: connect, add, complete and delete a task", async ({ page }) => {
  await connect(page);
  await page.getByLabel("New task").fill("Buy momo for the team");
  await page.getByTestId("add-task").click();
  await expect(status(page, "todo-h")).toHaveText(/Done/);
  await expect(page.getByTestId("tasks")).toContainText("Buy momo for the team");
  await expect(page.getByLabel("New task")).toHaveValue(""); // cleared only after success

  await page.getByLabel("Complete task 1").click();
  await expect(page.locator(".tasks li.done")).toHaveCount(1);
  await page.getByLabel("Delete task 1").click();
  await expect(page.getByTestId("empty")).toBeVisible();
  expect(await sentCount(page)).toBe(3);
});

test("two tasks in a row, then a top-up: inputs keep what you type", async ({ page }) => {
  await connect(page);
  for (const t of ["First task", "Second task"]) {
    await page.getByLabel("New task").fill(t);
    await expect(page.getByLabel("New task")).toHaveValue(t);
    await page.getByTestId("add-task").click();
    await expect(page.locator(".tasks li", { hasText: t })).toBeVisible();
  }
  await page.getByLabel("Amount in ETH").fill("1");
  await page.getByTestId("deposit").click();
  await expect(page.getByTestId("saved")).toHaveText("1 ETH");
  await page.getByLabel("Amount in ETH").fill("0.25"); // top-up: same unlock date
  await expect(page.getByLabel("Amount in ETH")).toHaveValue("0.25");
  await page.getByTestId("deposit").click();
  await expect(page.getByTestId("saved")).toHaveText("1.25 ETH");
});

test("wrong network: banner, every write blocked, one click to switch", async ({ page }) => {
  await connect(page, { chainId: "0x1" }); // wallet starts on Ethereum mainnet
  await expect(page.getByTestId("wrong-network")).toContainText("Wrong network: your wallet is on chain 1");
  await expect(page.getByTestId("add-task")).toBeDisabled();
  await expect(page.getByTestId("deposit")).toBeDisabled();
  await expect(page.getByTestId("withdraw")).toBeDisabled();

  await page.getByRole("button", { name: /Switch to Hardhat/ }).click();
  await expect(page.getByTestId("wrong-network")).toHaveCount(0);
  await page.getByLabel("New task").fill("Now on the right chain");
  await page.getByTestId("add-task").click();
  await expect(page.getByTestId("tasks")).toContainText("Now on the right chain");
  const sent = await page.evaluate(() => window.__wallet.sent);
  expect(sent.map((s) => s.chainId)).toEqual(["0x7a69"]); // nothing was ever sent on chain 1
});

test("rejected network switch: stays blocked, explains why", async ({ page }) => {
  await connect(page, { chainId: "0x1" });
  await page.evaluate(() => window.__wallet.setRejectSwitch(true));
  await page.getByRole("button", { name: /Switch to Hardhat/ }).click();
  await expect(page.getByTestId("wrong-network")).toContainText("You rejected the request");
  await expect(page.getByTestId("add-task")).toBeDisabled();
  expect(await sentCount(page)).toBe(0);
});

test("right chain id but contracts missing (e.g. node restarted): writes blocked", async ({ page }) => {
  const { default: dep } = await import("../lib/deployments.json", { with: { type: "json" } });
  await rpc("hardhat_setCode", [dep.contracts.TodoList.address, "0x"]); // undone by evm_revert
  await connect(page);
  await expect(page.getByTestId("not-deployed")).toBeVisible();
  await expect(page.getByTestId("add-task")).toBeDisabled();
  await expect(page.getByTestId("deposit")).toBeDisabled();
});

test("wallet changes network mid-session: banner appears, writes lock", async ({ page }) => {
  await connect(page);
  await page.evaluate(() => window.__wallet.setChain("0x89")); // Polygon
  await expect(page.getByTestId("wrong-network")).toContainText("chain 137");
  await expect(page.getByTestId("add-task")).toBeDisabled();
});

test("silent network change (no event): the live check still refuses to send", async ({ page }) => {
  await connect(page);
  await page.evaluate(() => window.__wallet.setChain("0x1", true)); // app is NOT told
  await page.getByLabel("New task").fill("Should never be sent");
  await page.getByTestId("add-task").click();
  await expect(status(page, "todo-h")).toHaveAttribute("data-kind", "wrong-network");
  await expect(status(page, "todo-h")).toContainText("wrong network");
  expect(await sentCount(page)).toBe(0);
  await expect(page.getByTestId("add-task")).toBeEnabled(); // not stuck
});

test("rejected transaction: clear message, nothing changes, retry works", async ({ page }) => {
  await connect(page);
  await page.evaluate(() => window.__wallet.setReject(true));
  await page.getByLabel("New task").fill("Pay electricity bill");
  await page.getByTestId("add-task").click();
  await expect(status(page, "todo-h")).toHaveAttribute("data-kind", "rejected");
  await expect(status(page, "todo-h")).toContainText("You rejected the request in your wallet");
  await expect(page.getByTestId("empty")).toBeVisible();              // no task appeared
  await expect(page.getByLabel("New task")).toHaveValue("Pay electricity bill"); // text kept
  await expect(page.getByTestId("add-task")).toBeEnabled();           // not stuck on "waiting"

  await page.evaluate(() => window.__wallet.setReject(false));
  await page.getByTestId("add-task").click();
  await expect(page.getByTestId("tasks")).toContainText("Pay electricity bill");
});

test("rejected connect: friendly message, still disconnected", async ({ page }) => {
  await installWallet(page, { rejectConnect: true });
  await page.goto("/");
  await page.getByTestId("connect").click();
  await expect(page.locator("p.error[role=alert]")).toContainText("You rejected the request");
  await expect(page.getByTestId("account")).toHaveCount(0);
});

test("piggy bank: a locked withdraw is caught before the wallet opens; works after unlock", async ({ page }) => {
  await connect(page);
  await page.getByLabel("Amount in ETH").fill("1.5");
  await page.getByLabel("Lock days").fill("30");
  await page.getByTestId("deposit").click();
  await expect(page.getByTestId("saved")).toHaveText("1.5 ETH");
  expect(await sentCount(page)).toBe(1);

  await page.getByTestId("withdraw").click();
  await expect(status(page, "piggy-h")).toContainText("still locked");
  await expect(status(page, "piggy-h")).toHaveAttribute("data-kind", "reverted");
  expect(await sentCount(page)).toBe(1); // simulation stopped it: no wallet pop-up

  await rpc("evm_increaseTime", [31 * 86400]);
  await rpc("evm_mine");
  await expect(page.getByTestId("withdraw")).toHaveText("Withdraw all");
  await page.getByTestId("withdraw").click();
  await expect(page.getByTestId("saved")).toHaveText("0 ETH");
});

test("bad form input never reaches the wallet", async ({ page }) => {
  await connect(page);
  for (const bad of ["", "-1", "1e18", "0", "abc", "0.0000000000000000001"]) {
    await page.getByLabel("Amount in ETH").fill(bad);
    await page.getByTestId("deposit").click();
    await expect(page.locator("section[aria-labelledby='piggy-h'] p.error")).toBeVisible();
  }
  await page.getByLabel("Amount in ETH").fill("1");
  await page.getByLabel("Lock days").fill("99999");
  await page.getByTestId("deposit").click();
  await expect(page.locator("section[aria-labelledby='piggy-h'] p.error")).toContainText("1 to 3650");
  await page.getByLabel("New task").fill("   ");
  await page.getByTestId("add-task").click();
  await expect(page.locator("section[aria-labelledby='todo-h'] p.error")).toContainText("Write something");
  expect(await sentCount(page)).toBe(0);
});

test("task text is shown as text, never run as HTML", async ({ page }) => {
  await connect(page);
  const evil = `<img src=x onerror="window.__xss=1">`;
  await page.getByLabel("New task").fill(evil);
  await page.getByTestId("add-task").click();
  await expect(page.locator(".task-text")).toHaveText(evil);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator(".tasks img")).toHaveCount(0);
});

test("double click sends only one transaction", async ({ page }) => {
  await connect(page);
  await page.getByLabel("New task").fill("Only once");
  await page.getByTestId("add-task").dblclick();
  await expect(page.getByTestId("tasks")).toContainText("Only once");
  await page.waitForTimeout(500);
  expect(await sentCount(page)).toBe(1);
  await expect(page.locator(".tasks li")).toHaveCount(1);
});

test("more ETH than you own: plain-words message, nothing sent", async ({ page }) => {
  await connect(page);
  await page.getByLabel("Amount in ETH").fill("50000"); // test accounts hold 10,000 ETH
  await page.getByLabel("Lock days").fill("30");
  await page.getByTestId("deposit").click();
  await expect(status(page, "piggy-h")).toHaveAttribute("data-kind", "funds");
  await expect(status(page, "piggy-h")).toContainText("not have enough ETH");
  expect(await sentCount(page)).toBe(0);
});

// The wallet "Cancel" / "Speed up" buttons send a NEW transaction with the same nonce.
// The app must notice its own transaction never ran, and not show "Done".
test("transaction cancelled from the wallet: no fake 'Done', task still there", async ({ page }) => {
  await connect(page);
  await page.getByLabel("New task").fill("Keep me");
  await page.getByTestId("add-task").click();
  await expect(page.getByTestId("tasks")).toContainText("Keep me");

  await rpc("evm_setAutomine", [false]);
  try {
    await page.getByLabel("Delete task 1").click();
    await expect(status(page, "todo-h")).toContainText("Waiting for the block");
    const [{ tx }] = (await page.evaluate(() => window.__wallet.sent)).slice(-1);
    const nonce = await rpc("eth_getTransactionCount", [tx.from, "latest"]);
    // Same nonce, 0 ETH to yourself, higher fee: exactly what "Cancel" does in MetaMask.
    await rpc("eth_sendTransaction", [{ from: tx.from, to: tx.from, value: "0x0", nonce,
      maxFeePerGas: "0x174876e800", maxPriorityFeePerGas: "0x77359400" }]);
    await rpc("evm_mine");
  } finally { await rpc("evm_setAutomine", [true]); }
  await expect(status(page, "todo-h")).toHaveAttribute("data-kind", "replaced", { timeout: 20_000 });
  await expect(status(page, "todo-h")).toContainText("cancelled");
  await expect(page.getByTestId("tasks")).toContainText("Keep me");
  await expect(page.getByTestId("add-task")).toBeEnabled();
});

test("transaction dropped and never mined: the page stops waiting and says so", async ({ page }) => {
  await connect(page);
  await rpc("evm_setAutomine", [false]);
  try {
    await page.getByLabel("New task").fill("Lost in the mempool");
    await page.getByTestId("add-task").click();
    await expect(status(page, "todo-h")).toContainText("Waiting for the block");
    const hashes = (await rpc("eth_getBlockByNumber", ["pending", false])).transactions;
    for (const h of hashes) await rpc("hardhat_dropTransaction", [h]);
    await expect(status(page, "todo-h")).toHaveAttribute("data-kind", "timeout", { timeout: 20_000 });
    await expect(page.getByTestId("add-task")).toBeEnabled();
    await expect(page.getByLabel("New task")).toHaveValue("Lost in the mempool");
  } finally { await rpc("evm_setAutomine", [true]); }
});

test("security headers: CSP limits where the page can connect, no framing", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:8545/);
  expect(h["x-powered-by"]).toBeUndefined();
});
