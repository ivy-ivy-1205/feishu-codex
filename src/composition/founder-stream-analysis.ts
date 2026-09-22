import { CodexFounderPerspectiveAnalyzer } from '../adapters/codex-founder-perspective-analyzer.js';
import { CodexFounderStreamAnalyzer } from '../adapters/codex-founder-stream-analyzer.js';
import type { CodexJsonExecutor } from '../ports/json-executor.js';

export function createFounderAnalysisAdapters(input: { codex: CodexJsonExecutor }) {
  return {
    analyzer: new CodexFounderStreamAnalyzer(input),
    perspectiveAnalyzer: new CodexFounderPerspectiveAnalyzer(input)
  };
}
