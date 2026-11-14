export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_CHAT_MODEL = 'gpt-4.1-mini';
export const TEXT_CONNECTION_ID = 'custom';
export const VISION_CONNECTION_ID = 'vision-custom';
export const LEGACY_VISION_CONNECTION_ID = 'custom-vision';

export function isQuickVisionConnection(id: string): boolean {
  return id === VISION_CONNECTION_ID || id === LEGACY_VISION_CONNECTION_ID;
}

function openAiGpt6(baseUrl: string, model: string): string | undefined {
  if (new URL(baseUrl).origin !== 'https://api.openai.com') return undefined;
  return /^(gpt-6-(?:astra|sol|luna)|gpt-6\.1-(?:sol|terra))(?:-\d{4}-\d{2}-\d{2})?$/.exec(model)?.[1];
}

export function chatCompletionSupportsTools(baseUrl: string, model: string): boolean {
  const reasoningModel = openAiGpt6(baseUrl, model);
  return !reasoningModel || reasoningModel === 'gpt-6-luna' || reasoningModel === 'gpt-6-sol';
}

export function chatCompletionParameters(baseUrl: string, model: string, maxTokens: number, temperature?: number, tools = false): Record<string, number | string> {
  const limit: Record<string, number> = new URL(baseUrl).origin === 'https://api.openai.com'
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  // GPT-6 models accept sampling parameters only when reasoning is disabled.
  if (openAiGpt6(baseUrl, model)) {
    if (!tools || !chatCompletionSupportsTools(baseUrl, model)) return limit;
    return { ...limit, reasoning_effort: 'none', ...(temperature === undefined ? {} : { temperature }) };
  }
  return { ...limit, ...(temperature === undefined ? {} : { temperature }) };
}
