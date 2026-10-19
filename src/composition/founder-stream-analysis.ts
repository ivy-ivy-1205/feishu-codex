import { CodexFounderPerspectiveAnalyzer } from '../adapters/codex-founder-perspective-analyzer.js';
import { CodexFounderStreamAnalyzer } from '../adapters/codex-founder-stream-analyzer.js';
import { CodexFounderWorkMapClassifier } from '../adapters/codex-founder-work-map-classifier.js';
import { CodexSpaceProjectDigestAnalyzer } from '../adapters/codex-space-project-digest.js';
import type { CodexJsonExecutor } from '../ports/json-executor.js';

export function createFounderAnalysisAdapters(input: { codex: CodexJsonExecutor }) {
  return {
    analyzer: new CodexFounderStreamAnalyzer(input),
    classifier: new CodexFounderWorkMapClassifier(input),
    perspectiveAnalyzer: new CodexFounderPerspectiveAnalyzer(input),
    // Inert until the worker is started with spaceAnalysisEnabled (SPACE_SYNC_ANALYSIS_ENABLED).
    spaceDigestAnalyzer: new CodexSpaceProjectDigestAnalyzer(input)
  };
}
