import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { coverage } from '../src/harvest.mjs';

async function setPhase(provider, phase) {
  const response = await fetch(`${provider.url}/_phase`, {
    method: 'POST', body: JSON.stringify({ phase }) });
  assert.equal(response.status, 200);
}

test('动态采集：跟随 Period 与片段时间线，保留两层事件与原始载荷', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-live-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const harvest = () => fetch(`${service.url}/harvests`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/live' }) });
    const first = await harvest();
    assert.equal(first.status, 201);
    const summary = await first.json();
    assert.equal(summary.status, 'completed');
    const p1 = summary.periods.find(period => period.periodId === 'p1');
    assert.equal(p1.declared, 2);
    assert.equal(p1.fetched, 2);

    const events = await (await fetch(`${service.url}/events`)).json();
    const mpdEvent = events.find(event => event.layer === 'mpd-eventstream');
    assert.equal(mpdEvent.periodId, 'p2');
    assert.equal(mpdEvent.scheme, 'urn:demo:ad');
    assert.equal(mpdEvent.timescale, '10');
    assert.equal(mpdEvent.payload.body, 'B');
    const emsgEvents = events.filter(event => event.layer === 'emsg');
    assert.equal(emsgEvents.length, 2);
    const v0 = emsgEvents.find(event => event.emsgVersion === 0);
    const v1 = emsgEvents.find(event => event.emsgVersion === 1);
    assert.equal(v0.timing.periodRelativeSeconds.seconds, '0.5');
    assert.equal(v1.timing.periodRelativeSeconds.seconds, '10.5');
    assert.equal(v0.carrier.timescale, '1000');
    assert.equal(v0.carrier.presentationTimeOffset, '500');
    assert.equal(v0.payload.utf8, '{"cue":"A"}');
    assert.equal(v1.payload.base64, Buffer.from('{"cue":"A"}').toString('base64'));
    assert.ok(events.every(event => event.periodKey.includes('p1') || event.periodKey.includes('p2')));

    const report = await (await fetch(`${service.url}/coverage`)).json();
    assert.deepEqual(report.flatMap(item => item.missingOrUnverified), []);
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('缩窗与缺失片段：旧观察保留，缺口可解释，不宣称无事件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-phase-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const harvest = () => fetch(`${service.url}/harvests`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/live' }) });
    await harvest();
    await setPhase(provider, 1);
    const second = await harvest();
    const summary = await second.json();
    assert.equal(summary.segmentFailures.length >= 1, true);

    const events = await (await fetch(`${service.url}/events`)).json();
    // 阶段 0 已观察的 emsg 仍然存在
    assert.equal(events.filter(event => event.layer === 'emsg').length, 2);
    const report = await (await fetch(`${service.url}/coverage`)).json();
    const p1 = report.find(item => item.periodId === 'p1');
    assert.equal(p1.windowShrunk, true);
    // 新阶段 startNumber=0 且 r=0，原窗口的 1.m4s/2.m4s 都被移出
    assert.deepEqual(p1.removedSegmentHrefs.map(href => href.split('/').at(-1)).sort(),
      ['1.m4s', '2.m4s']);
    // 新进入窗口的 0.m4s 来源 404，登记为未验证而非“无事件”
    assert.equal(p1.missingOrUnverified.length, 1);
    const missing = p1.missingOrUnverified[0];
    assert.ok(missing.href.endsWith('/segments/0.m4s'));
    assert.equal(missing.lastStatus, 'unavailable');
    assert.equal(missing.lastReason, 'source_status_404');
    assert.equal(missing.declaredInCurrentWindow, true);
    // 已成功观察过的旧片段保留，缩窗不回退其状态
    assert.equal(p1.observedCount, 2);
    const cycles = await (await fetch(`${service.url}/harvests`)).json();
    assert.equal(cycles.length, 2);
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('迟到片段在窗口恢复后补齐，重复字节不产生重复事件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-late-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const harvest = () => fetch(`${service.url}/harvests`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/live' }) });
    await harvest();
    await setPhase(provider, 1);
    await harvest();
    await setPhase(provider, 0);
    await harvest();
    await harvest();
    const events = await (await fetch(`${service.url}/events`)).json();
    assert.equal(events.filter(event => event.layer === 'emsg').length, 2);
    const report = coverage(service.harvester.state);
    const p1 = report.find(item => item.periodId === 'p1');
    // 当前窗口声明的来源都已验证；0.m4s 是缩窗期间出现又消失的历史缺口，保留为未验证而非抹掉
    assert.deepEqual(p1.missingOrUnverified.filter(item => item.declaredInCurrentWindow), []);
    assert.ok(p1.missingOrUnverified.some(item => item.href.endsWith('/segments/0.m4s')));
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('采集状态持久化，重启后历史周期与事件仍可查询', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-restart-'));
  const provider = await startProvider();
  const first = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${first.url}/harvests`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/live' }) });
    assert.equal(response.status, 201);
    await first.close();
  } finally { await first.close(); }
  const second = await startService({ source: provider.url, directory });
  try {
    const events = await (await fetch(`${second.url}/events`)).json();
    assert.equal(events.length, 3);
    const cycles = await (await fetch(`${second.url}/harvests`)).json();
    assert.equal(cycles.length, 1);
    const report = await (await fetch(`${second.url}/coverage`)).json();
    assert.equal(report.length, 2);
  } finally {
    await second.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('静态 MPD 也可走采集入口，EventStream 与 SegmentList emsg 同时入库', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-static-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/harvests`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(response.status, 201);
    const events = await (await fetch(`${service.url}/events`)).json();
    assert.equal(events.some(event => event.layer === 'mpd-eventstream' && event.payload.body === 'A'), true);
    assert.equal(events.filter(event => event.layer === 'emsg').length, 2);
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('GET 接口保持只读，兼容接口行为不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-compat-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    for (const path of ['/events', '/coverage', '/harvests']) {
      const response = await fetch(`${service.url}${path}`, { method: 'GET' });
      assert.equal(response.status, 200);
    }
    const intake = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(intake.status, 201);
    const records = await (await fetch(`${service.url}/records`)).json();
    assert.equal(records.length, 1);
    const health = await (await fetch(`${service.url}/health`)).json();
    assert.equal(health.ready, true);
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('采集只访问同源地址，跨源片段被标记为来源错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-origin-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/harvests`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'https://example.invalid/foreign' }) });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, 'outside_source');
  } finally {
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});
