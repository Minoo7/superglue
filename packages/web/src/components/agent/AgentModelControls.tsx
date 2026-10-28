"use client";

import { Button } from "@/src/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { useAgentContext } from "./AgentContextProvider";

export function AgentModelControls() {
  const { modelControls, messages, isLoading } = useAgentContext();
  const { selection, models, status, canSend, choose, refresh } = modelControls;
  const pendingConfirmation = messages.some(
    (message) =>
      message.tools?.some((tool) => tool.status === "awaiting_confirmation") ||
      message.parts?.some(
        (part) => part.type === "tool" && part.tool?.status === "awaiting_confirmation",
      ),
  );
  const streaming = isLoading || messages.some((message) => message.isStreaming);
  const disabled = streaming || pendingConfirmation;
  const selectedModel = models.find((model) => model.id === selection?.modelId);
  const unavailableModel = selection && !selectedModel;
  const unavailableEffort =
    selection?.reasoningEffort &&
    !selectedModel?.reasoningEfforts.includes(selection.reasoningEffort);

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs">
      <span>Model</span>
      <Select
        value={selection?.modelId ?? "deployment-default"}
        disabled={disabled}
        onValueChange={(id) => choose(id === "deployment-default" ? undefined : { modelId: id })}
      >
        <SelectTrigger
          aria-label="Model"
          className="h-8 w-auto min-w-[180px] max-w-[280px] text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="deployment-default">Deployment default</SelectItem>
          {unavailableModel && (
            <SelectItem value={selection.modelId} disabled>
              {selection.modelId} (unavailable)
            </SelectItem>
          )}
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selection && (!!selectedModel?.reasoningEfforts.length || !!selection.reasoningEffort) && (
        <>
          <span>Reasoning</span>
          <Select
            value={selection.reasoningEffort ?? "model-default"}
            disabled={disabled}
            onValueChange={(effort) =>
              choose({
                modelId: selection.modelId,
                ...(effort !== "model-default" ? { reasoningEffort: effort } : {}),
              })
            }
          >
            <SelectTrigger aria-label="Reasoning" className="h-8 w-auto min-w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="model-default">
                Model default
                {selectedModel?.defaultReasoningEffort
                  ? ` (${selectedModel.defaultReasoningEffort})`
                  : ""}
              </SelectItem>
              {unavailableEffort && (
                <SelectItem value={selection.reasoningEffort!} disabled>
                  {selection.reasoningEffort} (unavailable)
                </SelectItem>
              )}
              {selectedModel?.reasoningEfforts.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {effort}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      {status === "loading" && (
        <span className="text-muted-foreground" role="status">
          Loading models…
        </span>
      )}
      {status === "unavailable" && (
        <span className="text-muted-foreground" role="status">
          Models unavailable
        </span>
      )}
      {!canSend && (
        <span className="text-destructive" role="alert">
          Saved choice unavailable. Refresh or change it to send.
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 text-xs"
        disabled={streaming || status === "loading"}
        onClick={refresh}
      >
        Refresh models
      </Button>
    </div>
  );
}
