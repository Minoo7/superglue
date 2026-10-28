import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changeMode,
  createReleaseCommit,
  git,
  planPromotion,
  planRollback,
  publishRelease,
  renderCompose,
  validateRelease,
} from "./release.mjs";

const template = readFileSync(new URL("./compose.template.json", import.meta.url), "utf8");
const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const record = (sourceSha = a, digest = "1") => ({
  schemaVersion: 1,
  mode: "auto",
  sourceSha,
  highWaterSourceSha: sourceSha,
  image: `ghcr.io/minoo7/superglue@sha256:${digest.repeat(64)}`,
  datastoreTree: c,
  runId: "100",
  runAttempt: "1",
});
const promotion = (current, candidate = record(b, "2"), options = {}) =>
  planPromotion({ current, candidate, mainSha: candidate.sourceSha, descends: true, ...options });

test("first tested release is held", () => assert.equal(promotion(null).mode, "hold"));
test("fresh descendant advances image and high-water", () => {
  const result = promotion(record());
  assert.equal(result.sourceSha, b);
  assert.equal(result.highWaterSourceSha, b);
  assert.equal(result.previous.image, record().image);
});
test("stale main never changes release", () =>
  assert.throws(() => promotion(record(), record(b), { mainSha: a }), /no longer main/));
test("non-descendant never changes release", () =>
  assert.throws(() => promotion(record(), record(b), { descends: false }), /high-water/));
test("hold blocks a new candidate", () =>
  assert.equal(promotion(changeMode(record(), "hold")), null));
test("same source rerun cannot replace digest", () =>
  assert.equal(promotion(record(), record(a, "2")), null));
test("rollback freezes releases and preserves high-water", () => {
  const rolled = planRollback(record(b, "2"), record());
  assert.equal(rolled.mode, "hold");
  assert.equal(rolled.sourceSha, a);
  assert.equal(rolled.highWaterSourceSha, b);
  assert.equal(promotion(changeMode(rolled, "auto"), record(b, "3")), null);
});
test("rollback refuses changed datastore code", () =>
  assert.throws(
    () => planRollback(record(b), { ...record(), datastoreTree: b }),
    /Datastore changed/,
  ));
test("auto retains selected image", () =>
  assert.equal(changeMode(changeMode(record(), "hold"), "auto").image, record().image));
test("mutable images and malformed records fail validation", () => {
  for (const change of [
    { image: "ghcr.io/minoo7/superglue:main" },
    { schemaVersion: 2 },
    { mode: "yes" },
    { sourceSha: "main" },
    { runId: "x" },
  ])
    assert.throws(() => validateRelease({ ...record(), ...change }));
});
test("render keeps secret and hostname references and existing-volume requirements", () => {
  const result = renderCompose(template, record().image);
  assert.equal(result.services.superglue.image, record().image);
  assert.equal(
    result.services.superglue.environment.AUTH_TOKEN,
    "${SUPERGLUE_AUTH_TOKEN:?required}",
  );
  assert.equal(
    result.services["internal-https"].networks.default.aliases[0],
    "${SUPERGLUE_DIRECT_HOST:?required}",
  );
  assert.equal(result.services.superglue.stop_grace_period, "4h");
  for (const value of Object.values(result.volumes)) assert.equal(value.external, true);
});
test("render rejects duplicate tokens and implicit volumes", () => {
  assert.throws(
    () =>
      renderCompose(
        template.replace('"restart": "unless-stopped"', '"restart": "__SUPERGLUE_IMAGE__"'),
        record().image,
      ),
    /one image token/,
  );
  assert.throws(
    () => renderCompose(template.replace('"external": true', '"external": false'), record().image),
    /external/,
  );
});

function fixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), "gitops-test-"));
  const previous = process.cwd();
  try {
    const remote = join(directory, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    execFileSync("git", ["init", "-b", "main", join(directory, "work")], { stdio: "pipe" });
    process.chdir(join(directory, "work"));
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["commit", "--allow-empty", "-m", "Source"]);
    const main = git(["rev-parse", "HEAD"]);
    git(["remote", "add", "origin", remote]);
    git(["push", "origin", "main"]);
    fn({ remote, main });
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("orphan production contains only generated manifests and later commits fast-forward", () =>
  fixture(({ main }) => {
    const release = { ...record(), sourceSha: main, highWaterSourceSha: main };
    const first = publishRelease({
      remote: "origin",
      release,
      template,
      expectedMain: main,
      parent: null,
    });
    assert.equal(git(["ls-tree", "--name-only", first]), "compose.json\nrelease.json");
    assert.equal(git(["rev-list", "--parents", "-n", "1", first]), first);
    const second = publishRelease({
      remote: "origin",
      release: changeMode(release, "hold"),
      template,
      expectedMain: main,
      parent: first,
    });
    assert.equal(git(["rev-parse", `${second}^`]), first);
    assert.equal(git(["status", "--porcelain"]), "");
  }));
test("main advancing at write boundary refuses publication", () =>
  fixture(({ remote, main }) => {
    assert.throws(
      () =>
        publishRelease({
          remote: "origin",
          release: record(),
          template,
          expectedMain: main,
          parent: null,
          beforePush() {
            git(["commit", "--allow-empty", "-m", "New source"]);
            git(["push", "origin", "main"]);
          },
        }),
      /Main changed/,
    );
    assert.equal(git(["ls-remote", "--heads", remote, "production"]), "");
  }));
test("operator advance at write boundary refuses publication", () =>
  fixture(({ main }) => {
    const parent = publishRelease({
      remote: "origin",
      release: record(),
      template,
      expectedMain: main,
      parent: null,
    });
    const operator = createReleaseCommit({
      release: changeMode(record(), "hold"),
      template,
      parent,
    });
    assert.throws(
      () =>
        publishRelease({
          remote: "origin",
          release: record(b),
          template,
          expectedMain: main,
          parent,
          beforePush() {
            git(["push", "origin", `${operator}:refs/heads/production`]);
          },
        }),
      /Production changed/,
    );
    assert.equal(git(["ls-remote", "--heads", "origin", "production"]).split(/\s/)[0], operator);
    const competing = createReleaseCommit({
      release: record(b),
      template,
      parent,
      message: "Competing candidate",
    });
    assert.throws(
      () => git(["push", "origin", `${competing}:refs/heads/production`]),
      /Command failed/,
    );
  }));

test("operator mode and rollback preserve the selected historical Compose", () =>
  fixture(({ main }) => {
    const original = JSON.parse(template);
    original.services.superglue.cpus = 0.75;
    const first = publishRelease({
      remote: "origin",
      release: record(main),
      template: original,
      expectedMain: main,
      parent: null,
    });
    const updated = JSON.parse(template);
    updated.services.superglue.cpus = 1;
    publishRelease({
      remote: "origin",
      release: record(main, "2"),
      template: updated,
      expectedMain: main,
      parent: first,
    });
    const cli = fileURLToPath(new URL("./release.mjs", import.meta.url));
    execFileSync(process.execPath, [cli, "hold"], { stdio: "pipe" });
    let selected = git(["ls-remote", "--heads", "origin", "production"]).split(/\s/)[0];
    assert.equal(JSON.parse(git(["show", `${selected}:compose.json`])).services.superglue.cpus, 1);
    execFileSync(process.execPath, [cli, "rollback", first], { stdio: "pipe" });
    selected = git(["ls-remote", "--heads", "origin", "production"]).split(/\s/)[0];
    const compose = JSON.parse(git(["show", `${selected}:compose.json`]));
    assert.equal(compose.services.superglue.cpus, 0.75);
    assert.equal(compose.services.superglue.image, record(main).image);
    assert.equal(JSON.parse(git(["show", `${selected}:release.json`])).mode, "hold");
  }));
