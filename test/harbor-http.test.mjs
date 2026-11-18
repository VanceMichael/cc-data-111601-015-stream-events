import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

test('harbor HTTP 入口：POST 触发采集，GET 只读返回状态/事件/覆盖/观察', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-http-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const trigger = await fetch(`${service.url}/harbor/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/live' }) });
    assert.equal(trigger.status, 201);
    const summary = await trigger.json();
    assert.equal(summary.observation.type, 'dynamic');
    assert.equal(summary.segments.length, 2);

    const [state, events, coverage, observations] = await Promise.all(
      ['state', 'events', 'coverage', 'observations'].map(async name =>
        (await fetch(`${service.url}/harbor/${name}`)).json()));
    assert.equal(events.length, 3);
    assert.equal(coverage.length, 2);
    assert.ok(observations.some(o => o.kind === 'manifest'));
    assert.equal(state.source, provider.url);

    // GET 不能是写操作：对采集入口用 GET 返回 404，而不是执行采集
    const getIntake = await fetch(`${service.url}/harbor/intakes`);
    assert.equal(getIntake.status, 404);

    // 畸形与越界请求被拒，且不落 coverage
    const malformed = await fetch(`${service.url}/harbor/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{not-json' });
    assert.equal(malformed.status, 422);
    const bad = await fetch(`${service.url}/harbor/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }) });
    assert.equal(bad.status, 422);
    const foreign = await fetch(`${service.url}/harbor/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'https://example.invalid/live' }) });
    assert.equal(foreign.status, 422);
    const after = await (await fetch(`${service.url}/harbor/coverage`)).json();
    assert.equal(after.length, 2);

    // 兼容接口仍在
    assert.deepEqual(await (await fetch(`${service.url}/health`)).json(), { ready: true });
  } finally {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('harbor 状态与通用收件索引隔离存放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-isolate-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    await fetch(`${service.url}/harbor/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/live' }) });
    const records = await (await fetch(`${service.url}/records`)).json();
    const harbor = await (await fetch(`${service.url}/harbor/state`)).json();
    assert.equal(records.length, 1); // 通用收件只有单件 MPD
    assert.equal(harbor.events.length, 3); // harbor 独立保存解释后的事件
  } finally {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('可选跟随轮询按配置触发采集，失败不影响服务', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-watch-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory,
    harborPath: '/live', pollMs: 25 });
  try {
    const deadline = Date.now() + 3000;
    let observations = [];
    while (Date.now() < deadline) {
      observations = await (await fetch(`${service.url}/harbor/observations`)).json();
      if (observations.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(observations.length >= 2);
    assert.ok(observations.some(o => o.kind === 'manifest'));
    assert.ok(observations.some(o => o.kind === 'manifest-not-modified'));
    const events = await (await fetch(`${service.url}/harbor/events`)).json();
    assert.equal(events.length, 3); // 轮询不产生重复事件
  } finally {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
