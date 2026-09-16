export type AiModelOutcome = 'success' | 'pass' | 'unavailable' | 'http_error'
  | 'invalid_response' | 'timeout' | 'error';

export interface AiTelemetrySnapshot {
  decisions: number;
  smartDecisions: number;
  failedDecisions: number;
  totalDecisionMs: number;
  modelCalls: number;
  modelLatencyMs: number;
  promptCharacters: number;
  modelOutcomes: Record<AiModelOutcome, number>;
}

const outcomes = (): Record<AiModelOutcome, number> => ({
  success: 0, pass: 0, unavailable: 0, http_error: 0,
  invalid_response: 0, timeout: 0, error: 0,
});

let metrics: AiTelemetrySnapshot = {
  decisions: 0,
  smartDecisions: 0,
  failedDecisions: 0,
  totalDecisionMs: 0,
  modelCalls: 0,
  modelLatencyMs: 0,
  promptCharacters: 0,
  modelOutcomes: outcomes(),
};

/** Process-local aggregate telemetry. It deliberately stores no cards, prompts,
 * player IDs or room IDs. */
export function recordAiDecision(smart: boolean, elapsedMs: number, failed = false) {
  metrics.decisions++;
  metrics.smartDecisions += Number(smart);
  metrics.failedDecisions += Number(failed);
  metrics.totalDecisionMs += Math.max(0, elapsedMs);
  if (metrics.decisions % 100 === 0) {
    const averageDecisionMs = Math.round(metrics.totalDecisionMs / metrics.decisions);
    const averageModelMs = metrics.modelCalls
      ? Math.round(metrics.modelLatencyMs / metrics.modelCalls) : 0;
    console.info('[AI telemetry]', JSON.stringify({
      decisions: metrics.decisions,
      smartDecisions: metrics.smartDecisions,
      failedDecisions: metrics.failedDecisions,
      averageDecisionMs,
      modelCalls: metrics.modelCalls,
      averageModelMs,
      promptCharacters: metrics.promptCharacters,
      modelOutcomes: metrics.modelOutcomes,
    }));
  }
}

export function recordAiModelCall(
  outcome: AiModelOutcome, elapsedMs: number, promptCharacters = 0,
) {
  metrics.modelCalls++;
  metrics.modelLatencyMs += Math.max(0, elapsedMs);
  metrics.promptCharacters += Math.max(0, promptCharacters);
  metrics.modelOutcomes[outcome]++;
}

export function getAiTelemetrySnapshot(): AiTelemetrySnapshot {
  return { ...metrics, modelOutcomes: { ...metrics.modelOutcomes } };
}

export function resetAiTelemetry() {
  metrics = {
    decisions: 0, smartDecisions: 0, failedDecisions: 0,
    totalDecisionMs: 0, modelCalls: 0, modelLatencyMs: 0,
    promptCharacters: 0, modelOutcomes: outcomes(),
  };
}
