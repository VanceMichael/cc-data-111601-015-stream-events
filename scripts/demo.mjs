import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = (path, body) => fetch(`${service.url}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const setPhase = phase => fetch(`${provider.url}/_phase`,
  { method: 'POST', body: JSON.stringify({ phase }) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // 第一轮：跟随动态清单，领取 Period/片段，解释 EventStream 与 emsg。
  let cycle = await (await post('/harbor/intakes', { path: '/live' })).json();
  console.log('首轮采集', { periods: cycle.observation.periodIds,
    segments: cycle.segments.map(s => ({ url: s.url.split('/').pop(), status: s.status, emsg: s.emsgCount ?? 0 })) });

  // 第二轮：条件复核，清单未变化（304），不重复登记事件。
  cycle = await (await post('/harbor/intakes', { path: '/live' })).json();
  console.log('条件复核', cycle.observation.kind);

  // 第三轮：来源缩窗且片段缺失——只登记“未观察到”，不捏造无事件。
  await setPhase(1);
  cycle = await (await post('/harbor/intakes', { path: '/live' })).json();
  console.log('缩窗采集', { unavailable: cycle.segments.map(s => s.status), withheld: cycle.withheld });

  // 第四轮：新 Period 进入窗口、迟到片段发布，事件按 Period/scheme 分别登记。
  await setPhase(2);
  cycle = await (await post('/harbor/intakes', { path: '/live' })).json();
  console.log('新窗口采集', { periods: cycle.observation.periodIds,
    late: cycle.segments.find(s => s.url.endsWith('/3.m4s'))?.status, withheld: cycle.withheld });

  const state = await (await fetch(`${service.url}/harbor/state`)).json();
  console.log('持久事件', state.events.map(e => ({
    origin: e.origin, period: e.periodId, scheme: e.scheme, id: e.eventId,
    periodTime: e.timing.periodPresentationTime?.seconds ?? null })));
  console.log('覆盖范围', state.coverage.map(c => ({
    source: c.url.split('/').pop(), status: c.status,
    withheld: c.withheld ?? false, outOfWindow: c.outOfWindow ?? false })));

  // 兼容的单件收件接口仍可用。
  const legacy = await post('/intakes', { path: '/primary' });
  if (legacy.status !== 201) throw new Error(await legacy.text());
  console.log('兼容收件', (await legacy.json()).parsed.kind);
} finally {
  await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
}
