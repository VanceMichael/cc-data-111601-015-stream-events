import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCycle, coverage, emptyHarvest } from '../src/harvest.mjs';

const source = 'http://127.0.0.1:4101';
function cycle(id, overrides = {}) {
  return {
    id, at: `2026-11-17T00:00:0${id}Z`, manifestHref: `${source}/live`,
    manifestDigest: `m${id}`, type: 'dynamic', unsupported: [], segmentFailures: [],
    periodDeclared: {},
    periods: [],
    ...overrides,
  };
}
const p1 = { key: JSON.stringify({ id: 'p1', index: 0, start: 'PT0S' }),
  periodId: 'p1', index: 0, start: 'PT0S', startSeconds: 0,
  streams: [], declaredSegmentHrefs: [], segmentObservations: [] };
const p2 = { key: JSON.stringify({ id: 'p2', index: 1, start: 'PT20S' }),
  periodId: 'p2', index: 1, start: 'PT20S', startSeconds: 20,
  streams: [], declaredSegmentHrefs: [], segmentObservations: [] };

test('同 id 事件在不同 Period 下是不同事件', () => {
  const first = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, streams: [{ scheme: 'urn:demo:ad', value: null, timescale: '10',
      events: [{ id: '7', presentationTime: '0', body: 'A', attrs: { id: '7' } }] }] }],
    periodDeclared: { [p1.key]: [] } }));
  const second = applyCycle(first, cycle('2', {
    periods: [{ ...p2, streams: [{ scheme: 'urn:demo:ad', value: null, timescale: '10',
      events: [{ id: '7', presentationTime: '0', body: 'B', attrs: { id: '7' } }] }] }],
    periodDeclared: { [p2.key]: [] } }));
  const events = second.events;
  assert.equal(events.length, 2);
  assert.notEqual(events[0].key, events[1].key);
  assert.deepEqual(events.map(event => event.periodId).sort(), ['p1', 'p2']);
  assert.deepEqual([...new Set(events.map(event => event.eventId))], ['7']);
});

test('同 Period 同方案不同呈现位置的同 id 事件各自保留', () => {
  const state = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, streams: [
      { scheme: 'urn:demo:ad', value: 'break', timescale: '1000',
        events: [
          { id: '7', presentationTime: '100', body: 'A', attrs: { id: '7', presentationTime: '100' } },
          { id: '7', presentationTime: '200', body: 'C', attrs: { id: '7', presentationTime: '200' } },
        ] },
    ] }], periodDeclared: { [p1.key]: [] } }));
  assert.equal(state.events.length, 2);
});

test('不同 scheme 下相同 id 不合并', () => {
  const state = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, streams: [
      { scheme: 'urn:demo:a', value: null, timescale: '1', events: [{ id: '1', presentationTime: '0', body: 'x', attrs: { id: '1' } }] },
      { scheme: 'urn:demo:b', value: null, timescale: '1', events: [{ id: '1', presentationTime: '0', body: 'y', attrs: { id: '1' } }] },
    ] }], periodDeclared: { [p1.key]: [] } }));
  assert.equal(state.events.length, 2);
});

test('清单缩窗不删除已观察事件，并显式记录被移出窗口的来源', () => {
  const href1 = `${source}/segments/1.m4s`;
  const href2 = `${source}/segments/2.m4s`;
  const state1 = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, declaredSegmentHrefs: [href1, href2], segmentObservations: [
      { href: href1, number: 1, kind: 'SegmentTemplate', timelineT: 500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'fetched', digest: 'd1', emsgEvents: [] },
      { href: href2, number: 2, kind: 'SegmentTemplate', timelineT: 10500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'fetched', digest: 'd2', emsgEvents: [] },
    ] }], periodDeclared: { [p1.key]: [href1, href2] } }));
  const state2 = applyCycle(state1, cycle('2', {
    periods: [{ ...p1, declaredSegmentHrefs: [href2], segmentObservations: [
      { href: href2, number: 2, kind: 'SegmentTemplate', timelineT: 10500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'fetched', digest: 'd2', emsgEvents: [] },
    ] }], periodDeclared: { [p1.key]: [href2] } }));
  const period = state2.periods[0];
  assert.equal(period.shrunkFromCycle, '2');
  assert.deepEqual(period.removedSegmentHrefs, [href1]);
  assert.deepEqual(period.declaredSegmentHrefs, [href1, href2]);
  assert.deepEqual(period.observedSegmentHrefs, [href1, href2]);
  const report = coverage(state2)[0];
  assert.equal(report.windowShrunk, true);
  assert.deepEqual(report.removedSegmentHrefs, [href1]);
  assert.deepEqual(report.declaredButNotYetAttempted, []);
  assert.deepEqual(report.missingOrUnverified, []);
});

test('缺失来源登记为未验证，绝不表述成该段无事件', () => {
  const href = `${source}/segments/1.m4s`;
  const state = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [
      { href, number: 1, kind: 'SegmentTemplate', timelineT: 500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'unavailable',
        reason: 'source_status_404', emsgEvents: [] },
    ] }], periodDeclared: { [p1.key]: [href] },
    segmentFailures: [{ href, reason: 'source_status_404' }] }));
  assert.equal(state.events.length, 0);
  const report = coverage(state)[0];
  assert.equal(report.missingOrUnverified[0].href, href);
  assert.equal(report.missingOrUnverified[0].lastStatus, 'unavailable');
  assert.equal(report.eventCount, 0);
});

test('迟到片段在后续周期补齐，状态转为已观察且不产生重复事件', () => {
  const href = `${source}/segments/1.m4s`;
  const emsg = { version: 0, flags: 0, schemeIdUri: 'urn:demo:ad', value: 'break',
    timescale: 1000, presentationTimeDelta: '500', eventDuration: '1000', id: '7',
    payloadBase64: 'e30=', payloadUtf8: '{}', boxOffset: 0, boxSize: 20,
    timing: { resolvable: true } };
  const state1 = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [
      { href, number: 1, kind: 'SegmentTemplate', timelineT: 500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'unavailable',
        reason: 'source_status_404', emsgEvents: [] },
    ] }], periodDeclared: { [p1.key]: [href] },
    segmentFailures: [{ href, reason: 'source_status_404' }] }));
  const state2 = applyCycle(state1, cycle('2', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [
      { href, number: 1, kind: 'SegmentTemplate', timelineT: 500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'fetched',
        digest: 'd1', emsgEvents: [emsg] },
    ] }], periodDeclared: { [p1.key]: [href] } }));
  const state3 = applyCycle(state2, cycle('3', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [
      { href, number: 1, kind: 'SegmentTemplate', timelineT: 500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'fetched',
        digest: 'd1', emsgEvents: [emsg] },
    ] }], periodDeclared: { [p1.key]: [href] } }));
  assert.equal(state3.events.length, 1);
  assert.deepEqual(state3.events[0].observedIn, ['2', '3']);
  const ledger = state3.periods[0].segments[0];
  assert.equal(ledger.lastStatus, 'fetched');
  assert.equal(ledger.statuses.length, 2);
  assert.deepEqual(coverage(state3)[0].missingOrUnverified, []);
});

test('相同字节重复发布不新增事件，不同重发布记入 variants', () => {
  const href = `${source}/segments/1.m4s`;
  const emsg = digest => ({ version: 1, flags: 0, schemeIdUri: 'urn:demo:ad', value: 'break',
    timescale: 1000, presentationTime: '10500', eventDuration: '1000', id: '7',
    payloadBase64: 'e30=', payloadUtf8: '{}', boxOffset: 0, boxSize: 20,
    timing: { resolvable: true } });
  const observation = digest => ({ href, number: 1, kind: 'SegmentTemplate', timelineT: 500,
    duration: 10000, timescale: '1000', presentationTimeOffset: '500',
    status: 'fetched', digest, emsgEvents: [emsg(digest)] });
  const state1 = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [observation('d1')] }],
    periodDeclared: { [p1.key]: [href] } }));
  const state2 = applyCycle(state1, cycle('2', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [observation('d1')] }],
    periodDeclared: { [p1.key]: [href] } }));
  assert.equal(state2.events.length, 1);
  assert.deepEqual(state2.events[0].variants, ['d1']);
  const state3 = applyCycle(state2, cycle('3', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [observation('d9')] }],
    periodDeclared: { [p1.key]: [href] } }));
  assert.equal(state3.events.length, 1);
  assert.deepEqual(state3.events[0].variants, ['d1', 'd9']);
  assert.deepEqual(state3.periods[0].segments[0].digests, ['d1', 'd9']);
});

test('新一轮节目复用 Period id 时，按 Period 起点与索引区分，旧事件不迁移时间轴', () => {
  const p1b = { key: JSON.stringify({ id: 'p1', index: 2, start: 'PT40S' }),
    periodId: 'p1', index: 2, start: 'PT40S', startSeconds: 40,
    streams: [{ scheme: 'urn:demo:ad', value: null, timescale: '1',
      events: [{ id: '7', presentationTime: '0', body: 'Z', attrs: { id: '7' } }] }],
    declaredSegmentHrefs: [], segmentObservations: [] };
  const state1 = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, streams: [{ scheme: 'urn:demo:ad', value: null, timescale: '1',
      events: [{ id: '7', presentationTime: '0', body: 'A', attrs: { id: '7' } }] }] }],
    periodDeclared: { [p1.key]: [] } }));
  const state2 = applyCycle(state1, cycle('2', { periods: [p1b],
    periodDeclared: { [p1b.key]: [] } }));
  assert.equal(state2.periods.length, 2);
  assert.equal(state2.events.length, 2);
  const old = state2.events.find(event => event.periodStart === 'PT0S');
  const fresh = state2.events.find(event => event.periodStart === 'PT40S');
  assert.equal(old.payload.body, 'A');
  assert.equal(fresh.payload.body, 'Z');
  assert.equal(old.periodKey, p1.key);
  assert.notEqual(old.periodKey, fresh.periodKey);
});

test('清单不可用时周期记录缺口但不推进任何事件结论', () => {
  const state = emptyHarvest(source);
  const failed = applyCycle(state, { id: 'x1', at: 't', manifestHref: `${source}/live`,
    manifestDigest: null, type: null, status: 'manifest_unavailable',
    reason: 'source_status_503', periods: [], unsupported: [], segmentFailures: [] });
  assert.equal(failed.cycles[0].status, 'manifest_unavailable');
  assert.equal(failed.events.length, 0);
  assert.equal(failed.periods.length, 0);
});

test('清单刷新失败后的 coverage 回退到最近有效窗口，不把缺口误标为移出窗口', () => {
  const href = `${source}/segments/1.m4s`;
  const state1 = applyCycle(emptyHarvest(source), cycle('1', {
    periods: [{ ...p1, declaredSegmentHrefs: [href], segmentObservations: [
      { href, number: 1, kind: 'SegmentTemplate', timelineT: 500, duration: 10000,
        timescale: '1000', presentationTimeOffset: '500', status: 'unavailable',
        reason: 'source_status_404', emsgEvents: [] },
    ] }], periodDeclared: { [p1.key]: [href] },
    segmentFailures: [{ href, reason: 'source_status_404' }] }));
  const state2 = applyCycle(state1, { id: 'x2', at: 't', manifestHref: `${source}/live`,
    manifestDigest: null, type: null, status: 'manifest_unavailable',
    reason: 'source_status_503', periods: [], unsupported: [], segmentFailures: [] });
  const report = coverage(state2)[0];
  assert.equal(report.missingOrUnverified[0].declaredInCurrentWindow, true);
});
