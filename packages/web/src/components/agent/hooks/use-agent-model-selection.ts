"use client";

import type { AgentModelOption, AgentModelSelection } from "@superglue/shared";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCacheScopeIdentifier } from "@/src/lib/cache-scope-identifier";
import { loadFromCacheAsync, saveToCache } from "@/src/lib/cache-utils";
import { tokenRegistry } from "@/src/lib/token-registry";
import { isSelectionAvailable, parseModelSelection } from "@/src/lib/agent/model-controls";

const PREFERENCE_KEY = "superglue-agent-model-preference";
const subscribe = (listener: () => void) => tokenRegistry.subscribe(listener);
const serverScope = () => null;

export function useAgentModelSelection(enabled: boolean) {
  const scope = useSyncExternalStore(subscribe, getCacheScopeIdentifier, serverScope);
  const [conversationScope, setConversationScope] = useState(scope);
  const [choice, setChoice] = useState<{ scope: string | null; selection?: AgentModelSelection }>({
    scope: null,
  });
  const [catalog, setCatalog] = useState<{
    scope: string | null;
    models: AgentModelOption[];
    status: "loading" | "ready" | "unavailable";
  }>({ scope: null, models: [], status: "loading" });
  const preference = useRef<{ scope: string | null; selection?: AgentModelSelection }>({
    scope: null,
  });
  const revision = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selection = enabled && choice.scope === scope ? choice.selection : undefined;
  const models = enabled && catalog.scope === scope ? catalog.models : [];
  const status = catalog.scope === scope ? catalog.status : "loading";
  const canSend =
    !enabled || !selection || (status === "ready" && isSelectionAvailable(selection, models));

  useEffect(() => {
    if (enabled && scope && conversationScope === null) setConversationScope(scope);
  }, [enabled, scope, conversationScope]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const startRevision = revision.current;
    const pendingPreference = { scope };
    preference.current = pendingPreference;
    setChoice({ scope });
    if (scope) {
      loadFromCacheAsync<unknown>(PREFERENCE_KEY).then((value) => {
        if (!active || getCacheScopeIdentifier() !== scope) return;
        let saved: AgentModelSelection | undefined;
        try {
          saved = parseModelSelection(value ?? undefined);
        } catch {
          return;
        }
        if (preference.current === pendingPreference)
          preference.current = { scope, selection: saved };
        if (revision.current === startRevision) setChoice({ scope, selection: saved });
      });
    }
    return () => {
      active = false;
    };
  }, [enabled, scope]);

  useEffect(() => {
    if (!enabled || !scope) return;
    const controller = new AbortController();
    setCatalog({ scope, models: [], status: "loading" });
    fetch("/api/agent/models", {
      headers: { Authorization: `Bearer ${tokenRegistry.getToken()}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data: { models: AgentModelOption[] } = await response.json();
        if (!Array.isArray(data.models)) throw new Error();
        if (!controller.signal.aborted && getCacheScopeIdentifier() === scope) {
          setCatalog({ scope, models: data.models, status: "ready" });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && getCacheScopeIdentifier() === scope) {
          setCatalog({ scope, models: [], status: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [enabled, scope, refreshVersion]);

  const choose = useCallback(
    (next?: AgentModelSelection) => {
      if (!enabled || getCacheScopeIdentifier() !== scope) return;
      revision.current++;
      setConversationScope(scope);
      setChoice({ scope, selection: next });
      if (next) {
        preference.current = { scope, selection: next };
        saveToCache(PREFERENCE_KEY, next);
      }
    },
    [enabled, scope],
  );

  const restore = useCallback(
    (next?: AgentModelSelection) => {
      if (!enabled) return;
      revision.current++;
      setConversationScope(scope);
      setChoice({ scope, selection: next });
    },
    [enabled, scope],
  );

  const startNew = useCallback(() => {
    restore(preference.current.scope === scope ? preference.current.selection : undefined);
  }, [restore, scope]);

  const snapshot = useCallback(() => {
    revision.current++;
    if (enabled && getCacheScopeIdentifier() !== scope)
      throw new Error("Authentication changed. Please try again.");
    if (!canSend)
      throw new Error(
        "Selected model or reasoning is unavailable. Refresh models or choose another model.",
      );
    return selection ? { ...selection } : undefined;
  }, [enabled, scope, canSend, selection]);

  return {
    enabled,
    scope,
    persistenceEnabled: enabled && scope !== null && conversationScope === scope,
    selection,
    models,
    status,
    canSend,
    choose,
    restore,
    startNew,
    snapshot,
    refresh: () => setRefreshVersion((version) => version + 1),
  };
}
