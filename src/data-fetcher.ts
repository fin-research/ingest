/** Service Binding identity keeps scheduled jobs independent of browser sessions. */
export function dataFetcher(env: Pick<Env, 'DATA' | 'ARTICLE_API_BASE_URL'>) {
  const base = new URL(env.ARTICLE_API_BASE_URL);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) {
      throw new Error('Data binding request must target the configured data API');
    }
    if (!env.DATA) throw new Error('Data Service Binding is unavailable');
    return env.DATA.fetch(request);
  };
}
