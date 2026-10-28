#!/usr/bin/env bash
set -euo pipefail
npm run build --workspace=@superglue/shared
npm run build --workspace=@superglue/core
npm run type-check --workspace=@superglue/web
npm run test --workspace=@superglue/web
npm run test-no-watch --workspace=@superglue/core -- \
  api/response-helpers.test.ts \
  api/logs-shutdown.test.ts \
  tools/response-filters.test.ts \
  auth/access-rule-evaluator.test.ts \
  mcp/mcp-shutdown.test.ts \
  tools/tool-execution-drain.test.ts \
  utils/encryption.test.ts \
  utils/timezone.test.ts \
  tunnel/tunnel-url-rewrite.test.ts \
  tunnel/tunnel-registry.test.ts
node --test deploy/release.test.mjs
