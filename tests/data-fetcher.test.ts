import { describe, expect, it, vi } from 'vitest';
import { dataFetcher } from '../src/data-fetcher';

describe('Data Service Binding', () => {
  it('retains query, headers and cancellation while using the private binding', async () => {
    const bound = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const call = dataFetcher({ ARTICLE_API_BASE_URL: 'https://eastmoney.hasbai.xyz/data', DATA: {
      fetch: (input, init) => bound(new Request(input, init)), connect: () => { throw new Error('Unexpected socket use'); },
    } });
    const controller = new AbortController();
    const response = await call('https://eastmoney.hasbai.xyz/data/news?tag=中央政策', { headers: { Accept: 'application/json' }, signal: controller.signal });
    expect(response.status).toBe(200); expect(bound).toHaveBeenCalledTimes(1);
    const request = bound.mock.calls[0]![0];
    expect(new URL(request.url).searchParams.get('tag')).toBe('中央政策');
    expect(request.headers.get('Accept')).toBe('application/json');
    controller.abort(); expect(request.signal.aborted).toBe(true);
  });
  it('rejects alternate origins and paths instead of creating a general proxy', async () => {
    const bound = vi.fn();
    const call = dataFetcher({ ARTICLE_API_BASE_URL: 'https://eastmoney.hasbai.xyz/data', DATA: {
      fetch: bound, connect: () => { throw new Error('Unexpected socket use'); },
    } });
    await expect(call('https://other.test/data/news')).rejects.toThrow('configured data API');
    await expect(call('https://eastmoney.hasbai.xyz/database/news')).rejects.toThrow('configured data API');
    expect(bound).not.toHaveBeenCalled();
  });
});
