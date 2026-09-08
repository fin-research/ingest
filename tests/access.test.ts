import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Ingest has no human-login entrypoint. A website session must not turn its
// public HTTP entrypoint into a way to trigger a Cron or Workflow.
describe.each([
  ['anonymous', {}],
  ['test@18.cn site session', { Cookie: 'CF_Authorization=unit-test-account-session', 'Cf-Access-Authenticated-User-Email': 'test@18.cn' }],
] as const)('%s HTTP boundary', (_identity, headers) => {
  it('only exposes the read-only health response', async () => {
    const health = await SELF.fetch('https://ingest.test/health', { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', worker: 'ingest' });
    for (const [method, path] of [['POST', '/health'], ['POST', '/scheduled'], ['POST', '/workflows/article'],
      ['POST', '/ingest'], ['GET', '/admin'], ['GET', '/api/articles'], ['GET', '/']] as const) {
      const response = await SELF.fetch(`https://ingest.test${path}`, { method, headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
    }
  });
});
