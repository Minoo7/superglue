# Deploy a tested release

Merge changes into `Minoo7/superglue` `main`. The Release workflow verifies source, builds the whole application on ARM64, publishes an immutable GHCR digest, and tests that digest anonymously. It then advances `production`. Portainer polls `production` and applies `compose.json`.

The first release starts in `hold`. Later candidates leave a held release unchanged. Portainer does not check application health or roll back an unhealthy release. Each update restarts the single application container.

## Bootstrap the Git stack

1. Enable GitHub Actions after the upstream workflow guards are present. Pull requests run read-only verification and an ARM64 image build. Only a trusted `main` run publishes an image.
2. Merge the pipeline. If anonymous smoke rejects the first publication, make the GHCR package public in GitHub, then rerun the failed jobs. Keep the exact candidate digest. Do not add a registry credential to Portainer.
3. Read the running containers' mounts. Record all four physical volume names, table counts, object counts, current image, and unrelated service identities.
4. Pre-pull the tested digest. Stop the old application after its active work finishes. Stop the old stack. Confirm no running container uses any of the four volumes.
5. Create cold tar backups of all four volumes through read-only mounts. Store them outside Git, restrict access, verify archive readability, and record SHA-256 hashes. The new core can change the database schema on startup.
6. Create a new Git-backed Compose stack from this repository, `refs/heads/production`, and `compose.json`. Copy the old stack's five secret Env values privately. Add `SUPERGLUE_DIRECT_HOST` and the four `SUPERGLUE_*_VOLUME` variables named in the template. Use the exact existing names. Missing volumes must fail startup.
7. Enable polling with a permanent administrator account. Keep the old stack stopped with its metadata and image during the initial recovery window. Never start both stacks against these volumes.
8. Verify application health, authenticated API behavior, S3 roundtrip, preserved database and object counts, CPA chat tool continuation, model controls, and the unchanged unrelated services.
9. Enable automatic promotion with the command below. Merge a small real change, observe its new digest through polling without a manual redeploy, then perform the compatible rollback drill.

## Control promotion

Run these commands from a full source checkout with an authenticated Git remote for this fork. Set `GITOPS_REMOTE=fork` if `origin` points upstream.

```sh
GITOPS_REMOTE=fork node deploy/release.mjs hold
GITOPS_REMOTE=fork node deploy/release.mjs auto
```

Each command creates a normal fast-forward commit on `production`. Mode changes preserve the selected image and Compose. Promotion compares fresh main and production refs before pushing. Git rejects a competing production update. Git cannot atomically compare a read-only main ref while changing production, so main can still advance in that final interval.

A source SHA already at the high-water mark never promotes again, even after rollback. A candidate built while held is not queued for later promotion. After enabling `auto`, merge a new change to trigger the next release.

## Roll back compatible releases

Inspect the production history and choose the full commit SHA of a previously tested release. The command rejects a different datastore tree. Tree equality is necessary for this image-only drill, but does not prove arbitrary database schema compatibility. If schema compatibility is uncertain, use a separate backup restoration procedure before starting older code.

```sh
git fetch fork production
git log fork/production --oneline
GITOPS_REMOTE=fork node deploy/release.mjs rollback FULL_TESTED_PRODUCTION_COMMIT
```

Rollback selects that commit's tested image and Compose, preserves the high-water source SHA, and sets `hold`. Observe the previous digest and health through polling. To roll forward, use the same command with the known newer tested production commit, verify it, then enable `auto`. Do not force-push or rebuild a rollback image.

If the first migration fails, stop the new stack before touching the volumes. Restore the cold backup if startup changed data or schema. Start the old stack only after the new writers have stopped.

## Reproduce verification

```sh
npm ci --include=dev --include=optional --no-audit --no-fund
bash deploy/verify.sh
node --test deploy/release.test.mjs
```

The source check builds shared and core, checks web types, runs all web tests, and runs these offline core files. It does not run credential-dependent integration tests.

- `api/response-helpers.test.ts`
- `tools/response-filters.test.ts`
- `auth/access-rule-evaluator.test.ts`
- `mcp/mcp-shutdown.test.ts`
- `tools/tool-execution-drain.test.ts`
- `utils/encryption.test.ts`
- `utils/timezone.test.ts`
- `tunnel/tunnel-url-rewrite.test.ts`
- `tunnel/tunnel-registry.test.ts`

The image smoke resolves the registry index, ARM64 manifest, and config digests. It accepts Docker's corresponding config or manifest identity, requires the requested RepoDigest and source revision, and checks native canvas and sharp, Deno, every production Playwright version, web and API authentication, a Deno-backed tool, and an application S3 roundtrip. It also runs the browser confirmation recovery checks with synthetic responses, proves an in-flight Deno request completes during SIGTERM, then restarts and checks idle shutdown. Fixtures use disposable services and no production LLM credential. Live CPA behavior remains a hosted acceptance check.

Build and test an image only on ARM64 Docker. The Dockerfile uses the npm and Deno lockfiles and installs each production Playwright browser. CI prints free disk before and after cleanup. A local source check does not prove that the image builds or runs.

```sh
docker build -f deploy/Dockerfile --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t superglue-test .
node deploy/release.mjs candidate SOURCE_SHA ghcr.io/minoo7/superglue@sha256:TESTED_DIGEST RUN_ID ATTEMPT candidate.json
node deploy/smoke-image.mjs candidate.json
```
