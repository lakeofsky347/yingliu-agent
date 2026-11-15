import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiCompatibleRoot } from '../src/models/openai-root.ts';
import { chatTurn } from '../src/agent/model-client.ts';

test('DeepSeek official root and an existing /v1 root both reach chat completions once', async () => {
  assert.equal(openaiCompatibleRoot('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
  assert.equal(openaiCompatibleRoot('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  assert.equal(openaiCompatibleRoot('https://ailxp.top/v1/'), 'https://ailxp.top/v1');
  let url = '';
  await chatTurn(
    { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000, maxTokens: 16, supportsTools: false },
    'system',
    [{ role: 'user', content: 'hi' }],
    [],
    new AbortController().signal,
    async input => {
      url = String(input);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"message":"ok","done":true,"actions":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    },
  );
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
});
