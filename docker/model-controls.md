# Chat model controls

The main chat can select a model and a supported reasoning effort from the configured OpenAI-compatible provider's capability catalog. The model list uses the provider-specific `/models?client_version=superglue` format. Other providers can continue to use the deployment default.

Selections belong to each saved conversation. A new chat uses the browser's last explicit choice for the current API key. Loading an older chat restores that chat's selection. Existing conversations without a selection use the deployment default. Core workflow generation, summaries and playground agents keep their existing model configuration.

The server validates explicit selections before it initializes the agent. A missing or incompatible model is rejected. An unavailable catalog blocks explicit selection, while requests with no selection can still use the configured default. Model credentials stay on the server. Reasoning choices come from the provider's advertised capabilities; availability in the list does not prove that every listed model supports every agent tool.

The chat uses stateless Responses requests with `store: false`. Explicit reasoning-capable selections also request encrypted reasoning content through the SDK. This preserves multi-step continuation through a provider that does not retain response items.

## Build

`Dockerfile.model-controls` builds the shared package and web app from source. Its final stage keeps the pinned production image's core server, native modules, Deno and browser runtime. It replaces the built web app and shared output. No application secrets are required during the build.

Run from the repository root on the deployment architecture.

```sh
revision=$(git rev-parse HEAD)
docker buildx build --platform linux/arm64 --load \
  --build-arg SOURCE_REVISION="$revision" \
  --tag "superglue-model-controls:$revision" \
  --file docker/Dockerfile.model-controls .
```

The build requires public GitHub, npm and Google Fonts access. Keep the resulting image on the target Docker host or publish it to a controlled registry before deploying it. For a host-local image, use Compose `pull_policy: never` and record the resulting image ID. Remove any previous compiled-chunk stateless override when deploying this source-built image, because the source contains that fix.

If dependencies or core behavior change in a later update, review the runtime-layer strategy before reusing this recipe. The final stage retains the pinned image's production dependencies and core server.
