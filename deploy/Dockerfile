FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS dependencies
WORKDIR /usr/src/app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1 DISABLE_TELEMETRY=true
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN git config --global url.https://github.com/.insteadOf ssh://git@github.com/
COPY package.json package-lock.json tsconfig.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/web/package.json ./packages/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --include=dev --include=optional --no-audit --no-fund

FROM dependencies AS builder
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/web ./packages/web
RUN npm run build --workspace=@superglue/shared
RUN npm run build --workspace=@superglue/core
RUN NODE_OPTIONS=--max-old-space-size=6144 npm run build --workspace=@superglue/web

FROM dependencies AS production-dependencies
RUN rm -rf node_modules packages/core/node_modules packages/web/node_modules packages/shared/node_modules && npm ci --omit=dev --include=optional --no-audit --no-fund

FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/Minoo7/superglue" org.opencontainers.image.revision="$SOURCE_REVISION"
WORKDIR /usr/src/app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DISABLE_TELEMETRY=true PLAYWRIGHT_BROWSERS_PATH=/usr/src/app/.cache/ms-playwright DENO_DIR=/usr/src/app/.cache/deno
RUN groupadd -r nodejs --gid=1001 && useradd -r -g nodejs --uid=1001 --home-dir=/usr/src/app nodejs
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fontconfig fontconfig-config libfontconfig1 fonts-liberation \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    bash bubblewrap jq ripgrep coreutils grep sed gawk findutils curl unzip ca-certificates tini \
    freetds-bin unixodbc tdsodbc && \
    curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /usr/local/share/ca-certificates/aws-rds-global-bundle.crt && update-ca-certificates
RUN test "$(uname -m)" = aarch64 && \
    curl -fsSL https://dl.deno.land/release/v2.7.13/deno-aarch64-unknown-linux-gnu.zip -o /tmp/deno.zip && \
    echo 'c017fa8389bd96b6b07b3416bdb8d37074ab2ff1c83a9c94f7b2a6a7da026dac  /tmp/deno.zip' | sha256sum -c - && \
    unzip /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && deno --version
COPY --from=production-dependencies --chown=nodejs:nodejs /usr/src/app/ ./
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/web/.next ./packages/web/.next
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/web/public ./packages/web/public
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/web/next.config.ts ./packages/web/next.config.ts
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/web/src/lib/agent/skills/content ./packages/web/src/lib/agent/skills/content
COPY --from=builder --chown=nodejs:nodejs /usr/src/app/packages/core/deno-runtime ./packages/core/deno-runtime
COPY --chown=nodejs:nodejs deploy/playwright.mjs ./deploy/
RUN node deploy/playwright.mjs install && rm -rf /var/lib/apt/lists/* && mkdir -p .cache/deno .npm && chown -R nodejs:nodejs /usr/src/app
USER nodejs
RUN deno cache --frozen --allow-import packages/core/deno-runtime/workflow-executor.ts
EXPOSE 3001 3002
ENTRYPOINT ["tini", "-g", "--"]
CMD ["sh", "-c", "node node_modules/next/dist/bin/next start -p ${WEB_PORT:-3001} packages/web & exec node packages/core/dist/index.js"]
