import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, boxes, eventMessages } from '../src/reader.mjs';
import { planManifest, plannedSegments } from '../src/manifest.mjs';
import { interpretEmsg, interpretStreamEvent, emsgKey, streamEventKey } from '../src/timeline.mjs';
import { parseDuration, ticksToSeconds, rationalToDecimal, expandTimeline, applyTemplate, parseInteger } from '../src/iso.mjs';

const manifest = JSON.parse(await readFile(new URL('../fixtures/upstream.json', import.meta.url), 'utf8'));
async function resource(path, phase = 0) {
  const item = manifest.resources[path];
  const selected = { ...item, ...(item.phases?.[String(phase)] ?? {}) };
  return selected.file ? readFile(new URL(`../fixtures/${selected.file}`, import.meta.url))
    : Buffer.from(selected.body ?? '');
}

test('emsg v0/v1 原字段与原载荷完整保留', async () => {
  const v0 = eventMessages(await resource('/segments/1.m4s'));
  const v1 = eventMessages(await resource('/segments/2.m4s'));
  assert.equal(v0.length, 1);
  assert.deepEqual(
    { version: v0[0].version, scheme: v0[0].schemeIdUri, value: v0[0].value,
      timescale: v0[0].timescale, delta: v0[0].presentationTimeDelta,
      duration: v0[0].eventDuration, id: v0[0].id, body: Buffer.from(v0[0].messageBase64, 'base64').toString() },
    { version: 0, scheme: 'urn:demo:ad', value: 'break', timescale: 1000,
      delta: 500, duration: 1000, id: 7, body: '{"cue":"A"}' });
  assert.equal(v1[0].version, 1);
  assert.equal(v1[0].presentationTime, '10500');
  assert.equal(v1[0].messageBase64, Buffer.from('{"cue":"A"}').toString('base64'));
});

test('emsg 遍历嵌套容器且拒绝畸形 box', () => {
  // ftyp-only 片段结构合法但零 emsg，不能与“来源缺失”混为一谈。
  const empty = eventMessages(Buffer.concat([
    Buffer.from([0, 0, 0, 12]), Buffer.from('ftyp'), Buffer.from('iso5')]));
  assert.deepEqual(empty, []);
  assert.throws(() => eventMessages(Buffer.from([0, 0, 0, 9, 101, 109, 115, 115])), /mp4_box_size/);
  assert.throws(() => boxes(Buffer.from([0, 0, 0, 9, 101, 109, 115, 103])));
});

test('动态 MPD 展开 Period、$Number$ 模板与 SegmentTimeline（含 r 重复）', async () => {
  const bytes = await resource('/live');
  const plan = planManifest(bytes, 'http://source/live');
  assert.equal(plan.type, 'dynamic');
  assert.deepEqual(plan.periods.map(p => p.id), ['p1', 'p2']);
  const rep = plan.periods[0].representations[0];
  assert.equal(rep.timescale, '1000');
  assert.equal(rep.presentationTimeOffset, '500');
  assert.deepEqual(rep.segments.map(s => s.number), ['1', '2']);
  assert.deepEqual(rep.segments.map(s => s.url),
    ['http://source/segments/1.m4s', 'http://source/segments/2.m4s']);
  // t=500 d=10000 r=1，PTO=500：最早呈现时间为 0 与 10 秒
  assert.equal(rep.segments[0].earliestPresentationTime.seconds, '0');
  assert.equal(rep.segments[1].earliestPresentationTime.seconds, '10');
});

test('phase 1 缩窗清单：startNumber=0 只声明 0.m4s', async () => {
  const bytes = await resource('/live', 1);
  const plan = planManifest(bytes, 'http://source/live');
  const segments = plannedSegments(plan);
  assert.deepEqual(segments.map(s => s.url), ['http://source/segments/0.m4s']);
});

test('emsg v0 按片段最早呈现时间、v1 按绝对媒体时间减 PTO 落到 Period 轴', async () => {
  const bytes = await resource('/live');
  const plan = planManifest(bytes, 'http://source/live');
  const planned = plannedSegments(plan);
  const [seg1, seg2] = planned;
  const [v0] = eventMessages(await resource('/segments/1.m4s'));
  const [v1] = eventMessages(await resource('/segments/2.m4s'));
  const t0 = interpretEmsg(v0, seg1);
  const t1 = interpretEmsg(v1, seg2);
  assert.equal(t0.periodPresentationTime.seconds, '0.5');
  assert.equal(t0.rule, 'v0_delta_plus_segment_earliest_presentation_time');
  assert.equal(t1.periodPresentationTime.seconds, '10');
  assert.equal(t1.rule, 'v1_presentation_time_minus_presentation_time_offset');
  // 同一 id=7，原始 timescale/偏移仍可复核
  assert.equal(t0.emsgTimescale, 1000);
  assert.equal(t1.presentationTimeOffset, '500');
});

test('EventStream 事件保留声明 timescale，呈现时间直接位于 Period 轴', async () => {
  const bytes = await resource('/live');
  const plan = planManifest(bytes, 'http://source/live');
  const period = plan.periods.find(p => p.id === 'p2');
  const stream = period.streams[0];
  assert.equal(stream.timescale, '10');
  const timing = interpretStreamEvent(stream.events[0], stream);
  assert.equal(timing.periodPresentationTime.seconds, '0');
  assert.equal(stream.events[0].body, 'B');
});

test('相同 event id 在不同 Period 或 scheme 下身份不同', () => {
  const base = { source: 'http://s', periodId: 'p1',
    event: { version: 0, schemeIdUri: 'urn:a', value: 'v', id: 7, presentationTimeDelta: 1 }, boxOffset: 0 };
  const k1 = emsgKey(base);
  const k2 = emsgKey({ ...base, periodId: 'p2' });
  const k3 = emsgKey({ ...base, event: { ...base.event, schemeIdUri: 'urn:b' } });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  const sk1 = streamEventKey({ source: 'http://s', periodId: 'p1',
    stream: { scheme: 'urn:a', value: 'v', timescale: '1' },
    event: { identity: { id: '7', ordinal: 0 }, presentationTime: '0' } });
  const sk2 = streamEventKey({ source: 'http://s', periodId: 'p3',
    stream: { scheme: 'urn:b', value: 'v', timescale: '1' },
    event: { identity: { id: '7', ordinal: 0 }, presentationTime: '200' } });
  assert.notEqual(sk1, sk2);
});

test('ISO duration 精确分数与不同 timescale 换算无浮点误差', () => {
  assert.equal(parseDuration('PT1S').seconds.numerator, 1n);
  assert.equal(rationalToDecimal(parseDuration('PT0.5S').seconds), '0.5');
  assert.equal(parseDuration('PT1M30S').seconds.numerator, 90n);
  const ticks = ticksToSeconds(parseInteger('500', 'x'), 1000);
  assert.equal(rationalToDecimal(ticks), '0.5');
  // 1/3 秒在 timescale=1000 下不整除时保留余数，不静默取整
  const third = ticksToSeconds(1n, 3n);
  assert.equal(rationalToDecimal(third, 3), '0.333');
  assert.deepEqual(expandTimeline([{ t: '0', d: '10', r: '2' }], '0').map(p => p.t.toString()),
    ['0', '10', '20']);
  assert.equal(applyTemplate('seg/$Number$.m4s', { number: 7n }), 'seg/7.m4s');
  assert.equal(applyTemplate('seg/$Number%04d$.m4s', { number: 7n }), 'seg/0007.m4s');
  assert.throws(() => expandTimeline([{ t: '0', d: '10', r: '-1' }], '0'), /timeline_r_negative/);
});

test('静态清单原有 inspect 契约不变', async () => {
  const result = inspect(await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
  assert.equal(result.periods[0].streams[0].timescale, '1000');
  assert.equal(result.periods[0].streams[0].events[0].id, '7');
  assert.equal(result.periods[0].segments.length, 2);
});

test('畸形清单与不支持声明显式报错，不静默产出空计划', () => {
  assert.throws(() => planManifest(Buffer.from('<notMPD/>'), 'http://s/x'), /mpd_root/);
  // 无 SegmentTimeline 且无固定 duration 的模板无法安全推算，明确拒绝
  const noTimeline = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
    <Period id="p"><AdaptationSet><Representation id="r">
    <SegmentTemplate media="s/$Number$.m4s" timescale="1000" startNumber="1"/>
    </Representation></AdaptationSet></Period></MPD>`;
  assert.throws(() => planManifest(Buffer.from(noTimeline), 'http://s/x'), /fixed_duration_template_unsupported/);
  // 负 r 拒绝
  const badRepeat = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
    <Period id="p"><AdaptationSet><Representation id="r">
    <SegmentTemplate media="s/$Number$.m4s" timescale="1000" startNumber="1">
    <SegmentTimeline><S t="0" d="10" r="-2"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet></Period></MPD>`;
  assert.throws(() => planManifest(Buffer.from(badRepeat), 'http://s/x'), /timeline_r_negative/);
});

test('未知 emsg 版本与截断字段拒绝解析', () => {
  const unknown = Buffer.concat([
    Buffer.from([0, 0, 0, 16]), Buffer.from('emsg'),
    Buffer.from([2, 0, 0, 0]), Buffer.from('xxxx')]);
  assert.throws(() => eventMessages(unknown), /emsg_version_2/);
  const truncated = Buffer.concat([
    Buffer.from([0, 0, 0, 12]), Buffer.from('emsg'), Buffer.from([0, 0, 0, 0])]);
  assert.throws(() => eventMessages(truncated), /emsg/);
});

test('BaseURL 相对解析与同 URL 多 Representation 声明合并', () => {
  const mpd = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
    <BaseURL>http://origin.example/path/</BaseURL>
    <Period id="p"><AdaptationSet><Representation id="a">
    <SegmentTemplate media="seg/$Number$.m4s" timescale="1000" startNumber="1">
    <SegmentTimeline><S t="0" d="10" r="0"/></SegmentTimeline></SegmentTemplate>
    </Representation><Representation id="b">
    <SegmentTemplate media="seg/$Number$.m4s" timescale="1000" startNumber="1">
    <SegmentTimeline><S t="0" d="10" r="0"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet></Period></MPD>`;
  const plan = planManifest(Buffer.from(mpd), 'http://origin.example/path/manifest.mpd');
  const segments = plannedSegments(plan);
  assert.equal(segments.length, 1); // 同 URL 只领一次
  assert.equal(segments[0].url, 'http://origin.example/path/seg/1.m4s');
  assert.deepEqual(segments[0].declarations.map(d => d.representationId), ['a', 'b']);
});
