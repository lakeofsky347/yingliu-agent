export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_CHAT_MODEL = 'gpt-4.1-mini';
export const TEXT_CONNECTION_ID = 'custom';
export const VISION_CONNECTION_ID = 'vision-custom';

export function chatCompletionTokenLimit(baseUrl: string, maxTokens: number): Record<string, number> {
  return new URL(baseUrl).hostname === 'api.openai.com'
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}
