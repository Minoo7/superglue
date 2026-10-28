import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
const recovery = process.env.SUPERGLUE_CONFIRMATION_RECOVERY || "refresh";
assert(["refresh", "replace", "server"].includes(recovery));
const report = { outcome: "failed", chatRequests: 0, recovery };
const hash = (s) => s.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
const scope = "token:" + (hash(process.env.AUTH_TOKEN || "synthetic-pr-check") >>> 0).toString(16);
const cacheKey = "superglue-conversations-" + Math.abs(hash(scope));
let available = recovery !== "refresh";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.setDefaultTimeout(20000);
const tool = {
  id: "independent-pending",
  name: "call_system",
  status: "awaiting_confirmation",
  input: { url: "https://synthetic.invalid", method: "GET" },
  confirmationState: "pending",
};
const now = new Date().toISOString();
const convo = {
  id: "independent-confirm",
  title: "INDEPENDENT CONFIRMATION DIAGNOSTIC",
  sessionId: "independent-confirmation",
  timestamp: now,
  modelSelection:
    recovery === "replace"
      ? { modelId: "retired-model" }
      : { modelId: "gpt-6.1-terra", reasoningEffort: "low" },
  messages: [
    {
      id: "independent-user",
      role: "user",
      content: "INDEPENDENT CONFIRMATION DIAGNOSTIC",
      timestamp: now,
    },
    {
      id: "independent-assistant",
      role: "assistant",
      content: "Synthetic pending confirmation only.",
      timestamp: now,
      tools: [tool],
    },
  ],
};
try {
  await page.route("**/api/agent/models", (r) =>
    r.fulfill({
      status: available ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify(
        available
          ? {
              models: [
                {
                  id: "gpt-6.1-terra",
                  label: "GPT 6.1 Terra",
                  reasoningEfforts: ["low"],
                  defaultReasoningEffort: "low",
                },
              ],
            }
          : { error: "Synthetic catalog outage" },
      ),
    }),
  );
  await page.route("http://127.0.0.1:39999/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"data":[],"emailEntrySkipped":true}',
    }),
  );
  await page.route("**/api/agent/chat", (r) => {
    report.chatRequests++;
    const request = r.request().postDataJSON();
    assert.equal(request.resumeToolCallId, tool.id);
    assert.deepEqual(
      request.modelSelection,
      recovery === "replace" ? undefined : convo.modelSelection,
    );
    if (recovery === "server" && report.chatRequests === 1) {
      return r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Synthetic server catalog outage",
          code: "MODEL_SELECTION_REJECTED",
        }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"type":"done"}\n\n',
    });
  });

  await page.goto(process.env.SUPERGLUE_VERIFICATION_URL || "http://localhost:3341", {
    waitUntil: "domcontentloaded",
  });
  const skip = page.getByRole("button", { name: "Skip for now", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.getByRole("combobox", { name: "Model", exact: true }).waitFor();
  await page.getByRole("link", { name: "Tools", exact: true }).click();
  await page.waitForURL("**/tools");
  await page.evaluate(
    async ({ cacheKey, convo }) => {
      const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open("superglue");
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("cache", "readwrite");
        tx.objectStore("cache").put([convo], cacheKey);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { cacheKey, convo },
  );
  await page.getByRole("link", { name: "Agent", exact: true }).click();
  await page.getByRole("combobox", { name: "Model", exact: true }).waitFor();
  await page.getByRole("button", { name: "Past Chats", exact: true }).click();
  await page.locator('[data-history-panel] [title="Session: independent-confirmation"]').click();
  if (recovery !== "server")
    await page
      .getByText("Saved choice unavailable. Refresh or change it to send.", { exact: true })
      .waitFor();
  const confirm = page.getByRole("button", { name: "Confirm", exact: true });
  if (recovery === "server") {
    await confirm.click();
    await page.getByText("Synthetic server catalog outage", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Confirm" && !b.disabled,
      ),
    );
    report.restoredAfterServerRejection = true;
    await confirm.click();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Model"]')?.disabled,
    );
    assert.equal(report.chatRequests, 2);
    report.outcome = "passed";
  } else {
    report.confirmEnabledWhileUnavailable = await confirm.isEnabled();
    assert.equal(report.confirmEnabledWhileUnavailable, false);
    assert.equal(
      await page.getByRole("button", { name: "Cancel", exact: true }).isEnabled(),
      false,
    );
    assert.equal(
      await page.getByRole("button", { name: "Refresh models", exact: true }).isEnabled(),
      true,
    );
    assert.equal(report.chatRequests, 0);
    if (recovery === "replace") {
      await page.getByRole("combobox", { name: "Model", exact: true }).click();
      await page.getByRole("option", { name: "Deployment default", exact: true }).click();
    } else {
      available = true;
      await page.getByRole("button", { name: "Refresh models", exact: true }).click();
    }
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Confirm" && !b.disabled,
      ),
    );
    report.confirmEnabledAfterRecovery = await confirm.isEnabled();
    await confirm.click();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Model"]')?.disabled,
    );
    assert.equal(report.chatRequests, 1);
    report.outcome = "passed";
  }
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  await browser.close();
  await fs.writeFile(
    process.env.SUPERGLUE_DIAGNOSTIC_REPORT || "/tmp/superglue-model-confirmation.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (report.outcome !== "passed") process.exitCode = 1;
}
