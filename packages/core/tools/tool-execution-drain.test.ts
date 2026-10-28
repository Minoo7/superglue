import { setImmediate } from "node:timers/promises";
import { RequestSource } from "@superglue/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainToolExecutions, executeToolAsync } from "./tool-execution-service.js";
import type { ToolExecutionContext } from "./tool-execution-service.js";

const mocks = vi.hoisted(() => ({
  systems: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../systems/system-manager.js", () => ({
  SystemManager: { forToolExecution: mocks.systems },
}));
vi.mock("../runs/run-lifecycle.js", () => ({
  RunLifecycleManager: class {
    startRun = mocks.start;
    completeRun = mocks.complete;
  },
}));
vi.mock("../auth/role-resolver.js", () => ({ resolveUserRoles: async () => [] }));
vi.mock("../tunnel/index.js", () => ({
  setupTunnelsForTool: async () => ({ cleanups: [], tunnelMappings: {} }),
}));
vi.mock("../utils/logs.js", () => ({ logMessage: vi.fn() }));
vi.mock("../utils/webhook.js", () => ({ notifyWebhook: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ctx = {
  datastore: {},
  workerPools: { toolExecution: { runTask: mocks.run } },
  orgId: "fixture",
  metadata: { orgId: "fixture" },
  requestSource: RequestSource.API,
} as unknown as ToolExecutionContext;
const tool = { id: "fixture-tool", steps: [] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.systems.mockResolvedValue([]);
  mocks.start.mockResolvedValue({ runId: "fixture-run" });
  mocks.complete.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({
    runId: "fixture-run",
    success: true,
    stepResults: [],
    startedAt: new Date(),
    completedAt: new Date(),
  });
});

describe("tool execution drain", () => {
  it("should wait for accepted asynchronous work before Deno dispatch", async () => {
    const systems = deferred<[]>();
    mocks.systems.mockReturnValueOnce(systems.promise);
    await executeToolAsync(ctx, { tool });
    const finished = vi.fn();
    const draining = drainToolExecutions().then(finished);
    await setImmediate();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    systems.resolve([]);
    await draining;
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("should wait for run persistence after Deno becomes idle", async () => {
    const started = deferred<void>();
    const persisted = deferred<void>();
    mocks.complete.mockImplementationOnce(() => {
      started.resolve();
      return persisted.promise;
    });
    await executeToolAsync(ctx, { tool });
    await started.promise;
    const finished = vi.fn();
    const draining = drainToolExecutions().then(finished);
    await setImmediate();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    persisted.resolve();
    await draining;
    expect(finished).toHaveBeenCalledOnce();
  });

  it("should wait for chain lookup and its child execution after the parent finishes", async () => {
    const lookup = deferred<void>();
    const dispatched = deferred<void>();
    const persisted = deferred<void>();
    mocks.complete.mockResolvedValueOnce(undefined).mockReturnValueOnce(persisted.promise);
    await executeToolAsync(ctx, {
      tool,
      requestOptions: { webhookUrl: "tool:child" },
      onToolChain: async () => {
        dispatched.resolve();
        await lookup.promise;
        await executeToolAsync(ctx, { tool: { ...tool, id: "child" } });
      },
    });
    await dispatched.promise;
    const finished = vi.fn();
    const draining = drainToolExecutions().then(finished);
    await setImmediate();
    expect(finished).not.toHaveBeenCalled();
    lookup.resolve();
    await setImmediate();
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(finished).not.toHaveBeenCalled();
    persisted.resolve();
    await draining;
  });

  it("should release a rejected pre-dispatch execution without unhandled rejection", async () => {
    mocks.systems.mockRejectedValueOnce(new Error("fixture resolution failed"));
    await executeToolAsync(ctx, { tool });
    await drainToolExecutions();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
