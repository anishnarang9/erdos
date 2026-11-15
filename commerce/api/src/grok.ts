// T5 draft model (Grok adapter, recorder, replay). Owner: Coder C. Implement per ../CONTRACT-T5-T8.md §3.
export interface DraftOutput {
  name: string;
  format: "json" | "text" | "binary";
}

export type ModelDraft =
  | {
      kind: "draft";
      plan: unknown;
      examples: { name: string; files: { name: string; content: string }[]; predictedVerdict: 0 | 1 }[];
      sourceQuotes: { path: string; quote: string }[];
    }
  | { kind: "clarification"; questions: string[] }
  | { kind: "unsupported"; reason: string };

export interface DraftModelInput {
  request: string;
  outputs: DraftOutput[];
  referenceNames: string[];
  clarifications: { question: string; answer: string }[];
  schema: unknown;
}

export interface DraftModel {
  draft(input: DraftModelInput): Promise<{ result: ModelDraft; model: string; traceId: string }>;
}
