/** OpenAI-compatible roots such as https://api.deepseek.com omit /v1; the client adds it.
 *  A base that already names a path, including /v1, is left unchanged. */
export function openaiCompatibleRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '') url.pathname = '/v1';
  else url.pathname = path;
  return url.href.replace(/\/$/, '');
}
