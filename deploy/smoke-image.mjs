import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRelease } from "./release.mjs";

const release = validateRelease(JSON.parse(readFileSync(process.argv[2], "utf8")));
const directory = mkdtempSync(join(tmpdir(), "anonymous-ghcr-"));
const env = { ...process.env, DOCKER_CONFIG: directory };
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", env }).trim();
const digest = release.image.split("@")[1];
const tokenResponse = await fetch(
  "https://ghcr.io/token?service=ghcr.io&scope=repository:minoo7/superglue:pull",
);
assert(tokenResponse.ok, "Anonymous GHCR token unavailable; make package public");
const { token } = await tokenResponse.json();
async function manifest(reference) {
  const response = await fetch(`https://ghcr.io/v2/minoo7/superglue/manifests/${reference}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
    },
  });
  assert(response.ok, `Anonymous manifest request failed (${response.status})`);
  const raw = Buffer.from(await response.arrayBuffer());
  assert.equal(
    `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    reference,
    "Registry manifest digest mismatch",
  );
  return JSON.parse(raw.toString());
}
const root = await manifest(digest);
const arm = root.manifests?.find(
  (item) => item.platform?.os === "linux" && item.platform?.architecture === "arm64",
);
if (root.manifests) assert(arm, "Published index has no native ARM64 manifest");
const platformDigest = arm?.digest || digest;
const platform = arm ? await manifest(platformDigest) : root;
const configDigest = platform.config.digest;
const prefix = `sg-smoke-${process.pid}`;
const network = `${prefix}-net`;
const names = ["app", "postgres", "storage"].map((suffix) => `${prefix}-${suffix}`);
const [app, postgres, storage] = names;
const compose = JSON.parse(
  readFileSync(new URL("./compose.template.json", import.meta.url), "utf8"),
);
try {
  docker("pull", "--platform=linux/arm64", release.image);
  const inspected = JSON.parse(docker("image", "inspect", release.image))[0];
  assert.equal(inspected.Architecture, "arm64");
  assert.equal(inspected.Os, "linux");
  assert.equal(inspected.Config.Labels["org.opencontainers.image.revision"], release.sourceSha);
  assert(
    inspected.RepoDigests.includes(release.image),
    "Requested registry digest absent from Docker identity",
  );
  assert(
    [configDigest, platformDigest, digest].includes(inspected.Id),
    "Docker identity is outside requested OCI graph",
  );
  const graph = {
    requested: digest,
    platform: platformDigest,
    config: configDigest,
    dockerImageId: inspected.Id,
  };
  console.log(JSON.stringify(graph));
  docker("network", "create", network);
  docker(
    "run",
    "-d",
    "--name",
    postgres,
    "--network",
    network,
    "--network-alias",
    "postgres",
    "-e",
    "POSTGRES_USER=superglue",
    "-e",
    "POSTGRES_DB=superglue",
    "-e",
    "POSTGRES_PASSWORD=synthetic-postgres",
    compose.services.postgres.image,
  );
  docker(
    "run",
    "-d",
    "--name",
    storage,
    "--network",
    network,
    "--network-alias",
    "storage",
    "-e",
    "MINIO_ROOT_USER=superglue",
    "-e",
    "MINIO_ROOT_PASSWORD=synthetic-storage",
    compose.services.storage.image,
    "server",
    "/data",
  );
  async function ready(name, command) {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        docker("exec", name, ...command);
        return;
      } catch {
        await delay(1000);
      }
    }
    throw new Error(`${name} did not become ready`);
  }
  await ready(postgres, ["pg_isready", "-U", "superglue", "-d", "superglue"]);
  await ready(storage, ["curl", "-fsS", "http://127.0.0.1:9000/minio/health/live"]);
  const fixture = {
    AUTH_TOKEN: "synthetic-release-token",
    MASTER_ENCRYPTION_KEY: "synthetic-release-encryption-key",
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    POSTGRES_USERNAME: "superglue",
    POSTGRES_PASSWORD: "synthetic-postgres",
    POSTGRES_DB: "superglue",
    POSTGRES_SSL: "false",
    LLM_PROVIDER: "OPENAI",
    OPENAI_API_KEY: "synthetic-not-an-llm-credential",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    API_ENDPOINT: "http://127.0.0.1:39999",
    API_PORT: "3002",
    WEB_PORT: "3001",
    FILE_STORAGE_PROVIDER: "minio",
    S3_ENDPOINT: "http://storage:9000",
    MINIO_ROOT_USER: "superglue",
    MINIO_ROOT_PASSWORD: "synthetic-storage",
    MINIO_BUCKET_NAME: "superglue-files",
    DISABLE_TELEMETRY: "true",
  };
  docker(
    "run",
    "-d",
    "--name",
    app,
    "--network",
    network,
    "--shm-size=256m",
    ...Object.entries(fixture).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "--mount",
    `type=bind,src=${resolve("deploy")},dst=/smoke,readonly`,
    "--mount",
    `type=bind,src=${resolve("scripts")},dst=/checks,readonly`,
    release.image,
  );
  await ready(app, ["curl", "-fsS", "http://127.0.0.1:3002/v1/health"]);
  await ready(app, ["curl", "-fsS", "http://127.0.0.1:3001"]);
  docker(
    "exec",
    app,
    "sh",
    "-ec",
    "cp /smoke/smoke-runtime.mjs deploy/smoke-runtime.mjs; node deploy/smoke-runtime.mjs",
  );
  for (const recovery of ["refresh", "replace", "server"]) {
    docker(
      "exec",
      "-e",
      `SUPERGLUE_CONFIRMATION_RECOVERY=${recovery}`,
      "-e",
      "SUPERGLUE_VERIFICATION_URL=http://127.0.0.1:3001",
      app,
      "sh",
      "-ec",
      "cp /checks/verify-model-confirmation.mjs deploy/verify-model-confirmation.mjs; node deploy/verify-model-confirmation.mjs",
    );
  }
  docker("exec", app, "cp", "/smoke/smoke-drain.mjs", "deploy/smoke-drain.mjs");
  const drain = spawn("docker", ["exec", app, "node", "deploy/smoke-drain.mjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let drainOutput = "";
  drain.stdout.on("data", (chunk) => {
    drainOutput += chunk;
  });
  drain.stderr.on("data", (chunk) => {
    drainOutput += chunk;
  });
  const drained = new Promise((done, reject) => {
    drain.on("error", reject);
    drain.on("close", (code) =>
      code === 0 ? done() : reject(new Error(`In-flight drain failed (${code}): ${drainOutput}`)),
    );
  });
  await ready(app, ["test", "-f", "/tmp/release-deno-inflight"]);
  docker("kill", "--signal=SIGTERM", app);
  await drained;
  assert.match(drainOutput, /In-flight Deno request completed/);
  assert.equal(
    execFileSync("docker", ["wait", app], { encoding: "utf8", env, timeout: 30_000 }).trim(),
    "0",
  );
  const state = JSON.parse(docker("inspect", app))[0].State;
  assert.equal(state.ExitCode, 0, "Application did not stop cleanly");
  assert.equal(state.Running, false, "Application process namespace is still running");
  assert.equal(state.OOMKilled, false);
  assert.match(docker("logs", app), /Shutdown complete/);
  docker("start", app);
  await ready(app, ["curl", "-fsS", "http://127.0.0.1:3002/v1/health"]);
  docker("stop", "--time=30", app);
  const idle = JSON.parse(docker("inspect", app))[0].State;
  assert.equal(idle.ExitCode, 0, "Idle application did not stop cleanly");
  assert.equal(idle.Running, false);
  assert.equal(idle.OOMKilled, false);
  assert.equal(docker("logs", app).match(/Shutdown complete/g)?.length, 2);
  writeFileSync(
    "image-smoke.json",
    JSON.stringify(
      { ...graph, sourceSha: release.sourceSha, image: release.image, outcome: "passed" },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  try {
    console.error(docker("logs", app));
  } catch {}
  throw error;
} finally {
  for (const name of names) {
    try {
      docker("rm", "-f", "-v", name);
    } catch {}
  }
  try {
    docker("network", "rm", network);
  } catch {}
  rmSync(directory, { recursive: true, force: true });
}
