export interface AskParams {
  question: string;
  context: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

export interface AskUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AskResult {
  text: string;
  usage: AskUsage;
}

export interface Provider {
  ask(params: AskParams): Promise<AskResult>;
}
