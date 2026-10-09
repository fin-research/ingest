import { expect, it, vi } from 'vitest';
import { runScheduledCollection } from '../src/index';
import { scheduledTasks } from '../src/scheduled-tasks';
import { CloudflarePolicyWorkflowLauncher } from '../src/policy';
import { CloudflareTelegramWorkflowLauncher } from '../src/telegram';
it('private schedule boundary rejects invalid requests and holiday dispatch skips all collections',async()=>{
 const fetch=vi.fn(async()=>Response.json({date:'2026-10-01',isTradingDay:false,previousTradingDate:'2026-09-30'}));
 const env={DATA:{fetch},ARTICLE_API_BASE_URL:'https://eastmoney.hasbai.xyz/data'} as unknown as Env;
 for(const [path,method,status] of [['/other','POST',404],['/scheduled','GET',405],['/scheduled','POST',400],['/scheduled?scheduledTime=1','POST',400]] as const)
  expect((await scheduledTasks(new Request('https://internal'+path,{method}),env)).status).toBe(status);
 expect(fetch).not.toHaveBeenCalled();
 expect((await scheduledTasks(new Request('https://internal/scheduled?scheduledTime='+Date.parse('2026-10-01T01:20:00Z'),{method:'POST'}),env)).status).toBe(200);
 expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['policy','telegram'])('uncertain %s creates confirm an actual existing instance without restarting',async kind=>{
 const createError=new Error('create uncertain');
 const existing={id:kind+'-123',status:vi.fn(async()=>({status:'errored'}))};
 const workflow={create:vi.fn(async()=>{throw createError;}),get:vi.fn(async()=>existing)};
 const start=kind==='policy'?()=>new CloudflarePolicyWorkflowLauncher(workflow as unknown as Env['POLICY_WORKFLOW']).start(existing.id)
 :()=>new CloudflareTelegramWorkflowLauncher(workflow as unknown as Env['TELEGRAM_WORKFLOW']).start([],'1970-01-01T00:00:00.123Z');
 expect(await start()).toBe(existing.id);expect(workflow.get).toHaveBeenCalledWith(existing.id);expect(existing.status).toHaveBeenCalledTimes(1);
 existing.status.mockRejectedValueOnce(new Error('not found'));
 await expect(start()).rejects.toBe(createError);
});

it('legacy platform timestamps use the same planned minute as private dispatch',async()=>{
 const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
 try {
  const env={DATA:{fetch:async()=>Response.json({date:'2026-10-01',isTradingDay:false,previousTradingDate:'2026-09-30'})},ARTICLE_API_BASE_URL:'https://eastmoney.hasbai.xyz/data'} as unknown as Env;
  await runScheduledCollection(env,Date.parse('2026-10-01T01:20:34Z'));
  expect(log.mock.calls.map(args=>JSON.parse(String(args[0]))).find(entry=>entry.event==='ingest_cron_started').scheduledAt).toBe('2026-10-01T01:20:00.000Z');
 } finally { log.mockRestore(); }
});
