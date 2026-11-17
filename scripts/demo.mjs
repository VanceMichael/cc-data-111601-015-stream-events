import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const get = path => fetch(`${service.url}${path}`).then(response => response.json());
const post = (path, body) => fetch(`${service.url}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // 兼容入口：静态单件领取仍然可用
  const intake = await post('/intakes', { path: '/primary' });
  if (intake.status !== 201) throw new Error(await intake.text());
  console.log('静态单件接收', (await intake.json()).id);

  // 第一轮动态采集：跟随两个 Period 与 SegmentTimeline 领取片段，提取 EventStream 与 emsg
  const first = await post('/harvests', { path: '/live' });
  if (first.status !== 201) throw new Error(await first.text());
  console.log('第一轮动态采集', await first.json());
  console.log('已保存事件', await get('/events'));

  // 联调来源切换阶段：清单缩窗、片段 0 尚未发布（404），产品只登记缺口
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const second = await post('/harvests', { path: '/live' });
  if (second.status !== 201) throw new Error(await second.text());
  console.log('缩窗后采集（含来源缺口）', await second.json());
  console.log('已观察范围说明', await get('/coverage'));

  // 阶段恢复：迟到片段补齐，重复字节不新增事件
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
  const third = await post('/harvests', { path: '/live' });
  if (third.status !== 201) throw new Error(await third.text());
  console.log('窗口恢复后采集', await third.json());
  const events = await get('/events');
  console.log('最终事件数', events.length, 'GET 仍为只读查询');
  console.log('采集周期', (await get('/harvests')).map(cycle => ({ id: cycle.id, status: cycle.status })));
} finally {
  await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
}
