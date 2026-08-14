/**
 * What a model provider has to be able to do.
 *
 * One method, because that is all any feature here needs. The interface exists
 * because ai_features binds a model per feature and ai_models carries an
 * allowlist — both of which are pointless if there is only ever one provider
 * and its name is hardcoded at the call site.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type ChatResult =
  | { ok: true; content: string; usage: Usage }
  | { ok: false; reason: string; usage?: Usage };

export interface CompleteOptions {
  model: string;
  maxTokens: number;
  temperature?: number;
}

export interface Provider {
  name: string;
  complete(messages: ChatMessage[], options: CompleteOptions): Promise<ChatResult>;
}

/**
 * A failed call may still have spent tokens — a provider that errors after
 * generating has already billed for what it generated. `usage` on the failure
 * branch is how that reaches the ledger instead of being rounded to zero,
 * which is the quiet way a budget stops adding up.
 */
export const noUsage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
