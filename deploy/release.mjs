import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha = /^[a-f0-9]{40}$/;
const image = /^ghcr\.io\/minoo7\/superglue@sha256:[a-f0-9]{64}$/;
const templatePath = fileURLToPath(new URL("./compose.template.json", import.meta.url));
const services = ["postgres", "storage", "superglue", "storage-init", "ingress", "internal-https"];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateRelease(value) {
  check(value?.schemaVersion === 1, "Unsupported release schema");
  check(["auto", "hold"].includes(value.mode), "Invalid release mode");
  for (const field of ["sourceSha", "highWaterSourceSha", "datastoreTree"]) {
    check(sha.test(value[field]), `Invalid ${field}`);
  }
  check(image.test(value.image), "Expected immutable fork GHCR image");
  check(/^\d+$/.test(value.runId) && /^\d+$/.test(value.runAttempt), "Invalid run identity");
  if (value.previous) {
    check(
      sha.test(value.previous.sourceSha) && image.test(value.previous.image),
      "Invalid previous release",
    );
  }
  return value;
}

export function renderCompose(template, imageRef) {
  check(image.test(imageRef), "Expected immutable fork GHCR image");
  const text = typeof template === "string" ? template : JSON.stringify(template);
  check(text.split("__SUPERGLUE_IMAGE__").length === 2, "Expected one image token");
  const result = JSON.parse(text.replace("__SUPERGLUE_IMAGE__", imageRef));
  check(
    JSON.stringify(Object.keys(result.services).sort()) === JSON.stringify([...services].sort()),
    "Unexpected services",
  );
  check(Object.keys(result.volumes).length === 4, "Expected four existing volumes");
  for (const volume of Object.values(result.volumes)) {
    check(
      volume.external === true && /^\$\{SUPERGLUE_[A-Z_]+_VOLUME:\?required\}$/.test(volume.name),
      "Volumes must be external and required",
    );
  }
  check(!/\.ts\.net/.test(text), "Private hostname in public template");
  check(
    result.services.superglue.image === imageRef,
    "Image token is outside the application image",
  );
  check(
    !result.services.superglue.build && result.services.superglue.pull_policy !== "never",
    "Application must pull its image",
  );
  return result;
}

function identity(release) {
  return { sourceSha: release.sourceSha, image: release.image };
}

export function planPromotion({ current, candidate, mainSha, descends }) {
  validateRelease(candidate);
  check(candidate.sourceSha === mainSha, "Candidate is no longer main");
  if (!current) return { ...candidate, mode: "hold", highWaterSourceSha: candidate.sourceSha };
  validateRelease(current);
  if (candidate.sourceSha === current.highWaterSourceSha) return null;
  if (current.mode === "hold") return null;
  check(descends, "Candidate does not descend from high-water source");
  return validateRelease({
    ...candidate,
    mode: "auto",
    highWaterSourceSha: candidate.sourceSha,
    previous: identity(current),
  });
}

export function changeMode(current, mode) {
  return validateRelease({ ...validateRelease(current), mode });
}

export function planRollback(current, tested) {
  validateRelease(current);
  validateRelease(tested);
  check(
    current.datastoreTree === tested.datastoreTree,
    "Datastore changed; require a separate recovery procedure",
  );
  return validateRelease({
    ...tested,
    mode: "hold",
    highWaterSourceSha: current.highWaterSourceSha,
    previous: identity(current),
  });
}

export function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

export function createReleaseCommit({
  release,
  template,
  parent,
  cwd,
  message = "Release tested application",
}) {
  const directory = mkdtempSync(join(tmpdir(), "superglue-release-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
  const run = (args, input) => git(args, { cwd, env, input });
  try {
    run(["read-tree", "--empty"]);
    for (const [path, content] of Object.entries({
      "release.json": validateRelease(release),
      "compose.json": renderCompose(template, release.image),
    })) {
      const blob = run(["hash-object", "-w", "--stdin"], JSON.stringify(content, null, 2) + "\n");
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = run(["write-tree"]);
    return run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function remoteRef(remote, branch) {
  return git(["ls-remote", "--heads", remote, `refs/heads/${branch}`]).split(/\s/)[0] || null;
}

function fetchState(remote) {
  git(["fetch", "--no-tags", remote, "+refs/heads/main:refs/gitops/main"]);
  const parent = remoteRef(remote, "production");
  if (parent) git(["fetch", "--no-tags", remote, "+refs/heads/production:refs/gitops/production"]);
  const fetchedParent = parent ? git(["rev-parse", "refs/gitops/production"]) : null;
  return {
    mainSha: git(["rev-parse", "refs/gitops/main"]),
    parent: fetchedParent,
    current: fetchedParent ? JSON.parse(git(["show", `${fetchedParent}:release.json`])) : null,
    template: fetchedParent ? git(["show", `${fetchedParent}:compose.json`]) : null,
  };
}

export function publishRelease({
  remote,
  release,
  template,
  expectedMain,
  parent,
  beforePush = () => {},
}) {
  const commit = createReleaseCommit({ release, template, parent });
  beforePush();
  check(remoteRef(remote, "main") === expectedMain, "Main changed before push");
  check(remoteRef(remote, "production") === parent, "Production changed before push");
  git(["push", remote, `${commit}:refs/heads/production`]);
  return commit;
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  const template = readFileSync(templatePath, "utf8");
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  if (command === "render") {
    const release = validateRelease(read(args[0]));
    writeFileSync(args[1], JSON.stringify(renderCompose(template, release.image), null, 2) + "\n");
  } else if (command === "validate") {
    const release = validateRelease(read(args[0]));
    renderCompose(template, release.image);
    console.log("Release and template valid");
  } else if (command === "candidate") {
    const [sourceSha, imageRef, runId, runAttempt, output] = args;
    const release = validateRelease({
      schemaVersion: 1,
      mode: "hold",
      sourceSha,
      highWaterSourceSha: sourceSha,
      image: imageRef,
      datastoreTree: git(["rev-parse", `${sourceSha}:packages/core/datastore`]),
      runId,
      runAttempt,
    });
    writeFileSync(output, JSON.stringify(release, null, 2) + "\n");
  } else if (["promote", "hold", "auto", "rollback"].includes(command)) {
    const remote = process.env.GITOPS_REMOTE || "origin";
    const state = fetchState(remote);
    let release;
    let selectedTemplate = template;
    if (command === "promote") {
      const candidate = read(args[0]);
      check(
        git(["rev-parse", `${candidate.sourceSha}:packages/core/datastore`]) ===
          candidate.datastoreTree,
        "Candidate datastore identity mismatch",
      );
      let descends = false;
      if (state.current) {
        try {
          git([
            "merge-base",
            "--is-ancestor",
            state.current.highWaterSourceSha,
            candidate.sourceSha,
          ]);
          descends = true;
        } catch {}
      }
      release = planPromotion({ ...state, candidate, descends });
    } else {
      check(state.current, "Production has not been seeded");
      if (command === "rollback") {
        check(sha.test(args[0]), "Use a full tested production commit SHA");
        git(["merge-base", "--is-ancestor", args[0], state.parent]);
        release = planRollback(state.current, JSON.parse(git(["show", `${args[0]}:release.json`])));
        selectedTemplate = git(["show", `${args[0]}:compose.json`]).replace(
          release.image,
          "__SUPERGLUE_IMAGE__",
        );
      } else {
        release = changeMode(state.current, command);
        selectedTemplate = state.template.replace(state.current.image, "__SUPERGLUE_IMAGE__");
      }
    }
    if (!release) {
      console.log("No release change");
      return;
    }
    console.log(
      publishRelease({
        remote,
        release,
        template: selectedTemplate,
        expectedMain: state.mainSha,
        parent: state.parent,
      }),
    );
  } else throw new Error("Use candidate, validate, render, promote, hold, auto, or rollback");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
