export const founderFailureStages = ['input','topic_analysis','semantic_classification','topic_reconciliation','perspective_analysis','persistence'] as const;
export type FounderFailureStage = typeof founderFailureStages[number];

export const founderFailureCodes = ['input_invalid','schema_invalid','grounding_invalid','codex_auth_required',
  'codex_output_invalid','codex_execution_failed','perspective_invalid','lease_lost','unknown'] as const;
export type FounderFailureCode = typeof founderFailureCodes[number];

/** Convert an arbitrary exception to closed, non-sensitive labels only. */
export function classifyFounderFailure(error: unknown): FounderFailureCode {
  const value = error && typeof error === 'object' ? error as { code?: unknown; reason?: unknown } : {};
  if (value.code === 'CODEX_AUTH_REQUIRED') return 'codex_auth_required';
  if (value.code === 'CODEX_OUTPUT_INVALID') return 'codex_output_invalid';
  if (value.code === 'CODEX_EXECUTION_FAILED') return 'codex_execution_failed';
  if (value.code === 'FOUNDER_STREAM_INPUT_INVALID') return 'input_invalid';
  if (value.code === 'FOUNDER_STREAM_OUTPUT_INVALID') {
    if (value.reason === 'schema_invalid') return 'schema_invalid';
    return 'grounding_invalid';
  }
  if (value.code === 'FOUNDER_PERSPECTIVE_INPUT_INVALID' || value.code === 'FOUNDER_PERSPECTIVE_OUTPUT_INVALID') return 'perspective_invalid';
  if (value.code === 'LEASE_LOST') return 'lease_lost';
  return 'unknown';
}
