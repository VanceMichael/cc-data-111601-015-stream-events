import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { createHarbor } from '../src/harbor.mjs';
import { HarborStore } from '../src/harbor-store.mjs';
import { digest } from '../src/harbor.mjs';

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-it-'));
  const provider = await startProvider();
  const harborDir = join(directory, 'harbor');
  const harbor = await createHarbor({ source: provider.url, directory: harborDir });
  const setPhase = phase => fetch(`${provider.url}/_phase`,
    { method: 'POST', body: JSON.stringify({ phase }) });
  return {
    directory, harborDir, provider, harbor, setPhase,
    cleanup: async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('动态采集：emsg 与 EventStream 事件按 Period/scheme 区分并保留原件字段', async () => {
  const h = await harness();
  try {
    await h.harbor.cycle('/live');
    const state = await h.harbor.store.snapshot();
    // p1 两个 emsg（v0/v1）+ p2 一个 EventStream
    assert.equal(state.events.length, 3);
    const emsgEvents = state.events.filter(e => e.origin === 'emsg');
    assert.deepEqual(emsgEvents.map(e => e.raw.version).sort(), [0, 1]);
    const p2 = state.events.find(e => e.periodId === 'p2');
    assert.equal(p2.origin, 'event-stream');
    assert.equal(p2.scheme, 'urn:demo:ad');
    assert.equal(p2.payload.body, 'B');
    // 原载荷字节可还原
    const v0 = emsgEvents.find(e => e.raw.version === 0);
    assert.equal(Buffer.from(v0.payload.messageBase64, 'base64').toString(), '{"cue":"A"}');
    // 时间换算锚点保留
    assert.equal(v0.timing.periodPresentationTime.seconds, '0.5');
    assert.equal(v0.timing.segmentEarliestPresentationTime.seconds, '0');
  } finally { await h.cleanup(); }
});

test('缺失来源不捏造无事件：404 保持 unavailable，到达后补齐且不重复登记', async () => {
  const h = await harness();
  try {
    await h.setPhase(1); // 只声明 0.m4s，且该资源 404
    const first = await h.harbor.cycle('/live');
    const missing = first.segments[0];
    assert.equal(missing.status, 'unavailable');
    let state = await h.harbor.store.snapshot();
    const coverage = state.coverage.find(c => c.url.endsWith('/0.m4s'));
    assert.equal(coverage.status, 'unavailable');
    assert.equal(coverage.emsgCount ?? 0, 0);
    assert.ok(coverage.attempts.some(a => a.error));
    assert.equal(state.events.length, 1); // 只有 p2 的 EventStream，绝无“0.m4s 无事件”记录
    // 再刷一次仍 404：attempts 累积，状态不翻转
    await h.harbor.cycle('/live');
    state = await h.harbor.store.snapshot();
    assert.equal(state.coverage.find(c => c.url.endsWith('/0.m4s')).attempts.length, 2);
    assert.equal(state.events.length, 1);
  } finally { await h.cleanup(); }
});

test('迟到片段：先 404 后发布，再次采集转为 fetched 且确认零事件', async () => {
  // 自带可控来源：seg/3.m4s 先 404，再发布一个不含 emsg 的合法片段。
  const ftyp = await readFile(new URL('../fixtures/resource-06.bin', import.meta.url));
  const mpd = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT1S">
    <Period id="p1" start="PT0S"><AdaptationSet><Representation id="v1">
    <SegmentTemplate media="seg/$Number$.m4s" timescale="1000" startNumber="3" presentationTimeOffset="0">
    <SegmentTimeline><S t="0" d="10000" r="0"/></SegmentTimeline>
    </SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
  const mpdEtag = `"${digest(Buffer.from(mpd))}"`;
  let published = false;
  const mock = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/live') {
      response.setHeader('Content-Type', 'application/dash+xml');
      response.setHeader('ETag', mpdEtag);
      if (request.headers['if-none-match'] === mpdEtag) {
        response.writeHead(304); return response.end();
      }
      return response.end(mpd);
    }
    if (url.pathname === '/seg/3.m4s') {
      if (!published) { response.writeHead(404); return response.end('not_yet'); }
      response.setHeader('Content-Type', 'video/mp4');
      return response.end(ftyp);
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${mock.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), 'harbor-late-'));
  const harbor = await createHarbor({ source, directory: join(directory, 'harbor') });
  try {
    const first = await harbor.cycle('/live');
    assert.equal(first.segments[0].status, 'unavailable');
    let coverage = (await harbor.store.snapshot()).coverage[0];
    assert.equal(coverage.status, 'unavailable');
    assert.equal(coverage.emsgCount ?? 0, 0);
    // 片段迟到发布；304 复核路径也会重试未成功来源
    published = true;
    const retry = await harbor.cycle('/live');
    assert.equal(retry.observation.kind, 'manifest-not-modified');
    assert.equal(retry.segments[0].status, 'fetched');
    coverage = (await harbor.store.snapshot()).coverage[0];
    assert.equal(coverage.status, 'fetched');
    assert.equal(coverage.emsgCount, 0); // 已领取且确认零事件，与“缺失”严格区分
    assert.equal(coverage.digest, digest(ftyp));
    assert.equal(coverage.attempts.length, 2);
    const state = await harbor.store.snapshot();
    assert.equal(state.events.length, 0); // 零事件是观察结论，不是捏造
  } finally {
    await new Promise(resolve => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('清单缩窗：未领到的来源标 withheld，已领事件保留且不搬到新 Period', async () => {
  const h = await harness();
  try {
    await h.harbor.cycle('/live'); // phase0：1/2.m4s 已领
    await h.setPhase(1);
    const shrunk = await h.harbor.cycle('/live'); // 只剩 0.m4s
    // 1/2.m4s 已领取且有事件：标记出窗但事件保留
    const state1 = await h.harbor.store.snapshot();
    const old = state1.coverage.filter(c => /\/[12]\.m4s$/.test(c.url));
    assert.ok(old.every(c => c.outOfWindow === true));
    assert.equal(state1.events.filter(e => e.periodId === 'p1').length, 2);
    assert.deepEqual(shrunk.withheld, []); // 已领的不算 withheld
    // 0.m4s 从未领到且已出窗（phase2 不再列）
    await h.setPhase(2);
    const next = await h.harbor.cycle('/live');
    assert.ok(next.withheld.some(url => url.endsWith('/0.m4s')));
    const state2 = await h.harbor.store.snapshot();
    const zero = state2.coverage.find(c => c.url.endsWith('/0.m4s'));
    assert.equal(zero.status, 'unavailable');
    assert.equal(zero.withheld, true);
    // 旧 Period 事件仍挂在 p1，未迁移到新节目 p3/p4 的时间轴
    assert.ok(state2.events.every(e => !(e.periodId === 'p3' && e.origin === 'emsg')));
    const p1Events = state2.events.filter(e => e.periodId === 'p1');
    assert.ok(p1Events.every(e => e.periodAnchor.raw === 'PT0S'));
  } finally { await h.cleanup(); }
});

test('新 Period 进入窗口后被采集；同 id 不同 scheme 是两个事件', async () => {
  const h = await harness();
  try {
    await h.harbor.cycle('/live');
    await h.setPhase(2);
    await h.harbor.cycle('/live');
    const state = await h.harbor.store.snapshot();
    const ids = state.periods.map(p => p.periodId);
    assert.ok(ids.includes('p3'));
    assert.ok(ids.includes('p4'));
    // id=7 在 p2(urn:demo:ad) 与 p3(urn:demo:news) 各算一个
    const sevens = state.events.filter(e => e.eventId === '7');
    const schemes = new Set(sevens.map(e => `${e.periodId}:${e.scheme}`));
    assert.ok(schemes.has('p2:urn:demo:ad'));
    assert.ok(schemes.has('p3:urn:demo:news'));
    const news = state.events.find(e => e.periodId === 'p3');
    assert.equal(news.timing.periodPresentationTime.seconds, '2'); // 200/100
  } finally { await h.cleanup(); }
});

test('重复发布相同字节不新增事件；304 复核仍尝试迟到来源', async () => {
  const h = await harness();
  try {
    await h.harbor.cycle('/live');
    const again = await h.harbor.cycle('/live'); // ETag 命中 304
    assert.equal(again.observation.kind, 'manifest-not-modified');
    const state = await h.harbor.store.snapshot();
    assert.equal(state.events.length, 3);
    assert.equal(state.observations.filter(o => o.kind === 'manifest').length, 1);
    // 切到不同内容再切回：phase3 重新发布与 phase0 完全相同的字节
    await h.setPhase(1);
    await h.harbor.cycle('/live');
    await h.setPhase(3);
    const republished = await h.harbor.cycle('/live');
    assert.equal(republished.observation.repeatedBytes, true);
    const after = await h.harbor.store.snapshot();
    assert.equal(after.events.length, 3); // 无重复事件
  } finally { await h.cleanup(); }
});

test('持久化重开：观察范围、coverage 与事件全部保留', async () => {
  const h = await harness();
  try {
    await h.harbor.cycle('/live');
    const before = await h.harbor.store.snapshot();
    const reopenedStore = await new HarborStore(h.harborDir).initialize();
    const after = await reopenedStore.snapshot();
    assert.equal(after.events.length, before.events.length);
    assert.equal(after.coverage.length, before.coverage.length);
    assert.equal(after.observations.length, before.observations.length);
    assert.deepEqual(after.events.map(e => e.key).sort(),
      before.events.map(e => e.key).sort());
  } finally { await h.cleanup(); }
});

test('同源边界：跨源地址拒绝且不产生 coverage', async () => {
  const h = await harness();
  try {
    const result = await h.harbor.cycle('https://example.invalid/live');
    assert.equal(result.error, 'outside_source');
    const state = await h.harbor.store.snapshot();
    assert.equal(state.coverage.length, 0);
    assert.equal(state.observations.at(-1).kind, 'manifest-fetch-error');
  } finally { await h.cleanup(); }
});

test('Period 身份冲突显式标记，不静默改时间轴', async () => {
  const h = await harness();
  try {
    await h.harbor.cycle('/live');
    // 手工注入同 id 不同起点的锚点，模拟 Period id 复用
    await h.harbor.store.mutate(state => {
      const p1 = state.periods.find(p => p.periodId === 'p1');
      p1.anchors.push({ observationId: 'x', start: { kind: 'duration', raw: 'PT99S' }, duration: null });
      p1.anchorConflict = true;
    });
    const state = await h.harbor.store.snapshot();
    const p1 = state.periods.find(p => p.periodId === 'p1');
    assert.equal(p1.anchorConflict, true);
    assert.equal(p1.anchors.length, 2);
  } finally { await h.cleanup(); }
});
