import { runScheduledCollection } from './index';

/** Reachable only through Messenger's provisioned ScheduledTasks binding. */
export async function scheduledTasks(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
  if (url.pathname !== '/scheduled') return new Response('Not Found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  const value = url.searchParams.get('scheduledTime');
  const scheduledTime = value && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || scheduledTime % 60_000 !== 0
    || !Number.isFinite(new Date(scheduledTime).getTime())) return Response.json({ error: 'INVALID_SCHEDULED_TIME' }, { status: 400 });
  await runScheduledCollection(env, scheduledTime);
  return Response.json({ ok: true });
}
