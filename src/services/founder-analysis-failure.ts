export const founderFailureStages = ['input','topic_analysis','semantic_classification','topic_reconciliation','evidence_preparation',
  'new_evidence_persistence','inherited_evidence_resolution','evidence_record_loading','founder_attribution','source_occurrence_lookup',
  'perspective_analysis','persistence'] as const;
export type FounderFailureStage = typeof founderFailureStages[number];

export const founderFailureCodes = ['input_invalid','schema_invalid','grounding_invalid','codex_auth_required',
  'codex_output_invalid','codex_execution_failed','perspective_invalid','existing_evidence_missing','lease_lost','unknown'] as const;
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
  if (error instanceof Error && error.message === 'FOUNDER_EXISTING_EVIDENCE_MISSING') return 'existing_evidence_missing';
  if (value.code === 'LEASE_LOST') return 'lease_lost';
  return 'unknown';
}
