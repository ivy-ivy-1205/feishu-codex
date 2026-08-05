export interface CodexJsonExecutor {
  executeJson(input: {
    prompt: string;
    outputSchema: Record<string, unknown>;
  }): Promise<unknown>;
}
