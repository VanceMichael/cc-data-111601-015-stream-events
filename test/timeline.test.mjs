import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseManifest, parseDuration, expandTimeline, fillNumber } from '../src/manifest.mjs';
import { parseEmsgBoxes, deriveTiming } from '../src/emsg.mjs';
import { parseXml, local } from '../src/xml.mjs';

const live = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const phase1 = Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT1S"><Period id="p1" start="PT0S"><AdaptationSet><Representation id="v1"><SegmentTemplate media="segments/$Number$.m4s" timescale="1000" startNumber="0" presentationTimeOffset="500"><SegmentTimeline><S t="500" d="10000" r="0"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period><Period id="p2" start="PT20S"><EventStream schemeIdUri="urn:demo:ad" timescale="10"><Event id="7" presentationTime="0">B</Event></EventStream></Period></MPD>');

test('ISO 8601 时长按交换范围解析且保留原件字符串', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT1S'), 1);
  assert.equal(parseDuration('P1D'), null);
});

test('SegmentTimeline 展开 t/d/r，r=0 只产出一段', () => {
  const node = parseXml(Buffer.from('<root><SegmentTimeline xmlns="x"><S t="500" d="10000" r="1"/></SegmentTimeline></root>'));
  const timeline = node.children[0];
  assert.deepEqual(expandTimeline(timeline, 1), [
    { number: 1, t: 500, d: 10000 },
    { number: 2, t: 10500, d: 10000 },
  ]);
  const single = parseXml(Buffer.from('<root><S xmlns="x" t="500" d="10000" r="0"/></root>'));
  assert.deepEqual(expandTimeline(single, 0), [{ number: 0, t: 500, d: 10000 }]);
});

test('$Number$ 模板支持零宽填充，非 Number 模板不静默丢弃', () => {
  assert.equal(fillNumber('seg/$Number$.m4s', 3), 'seg/3.m4s');
  assert.equal(fillNumber('seg/$Number%04d$.m4s', 3), 'seg/0003.m4s');
  assert.equal(fillNumber('seg/$Time$.m4s', 3), null);
});

test('动态清单跟随两个 Period 与片段时间线领取来源', () => {
  const { model, unsupported } = parseManifest(live, 'http://127.0.0.1:4101/live');
  assert.equal(model.type, 'dynamic');
  assert.equal(model.minimumUpdatePeriod, 'PT1S');
  assert.equal(model.periods.length, 2);
  const [p1, p2] = model.periods;
  assert.equal(p1.id, 'p1');
  const representation = p1.representations[0];
  assert.equal(representation.segments.length, 2);
  assert.deepEqual(representation.segments.map(segment => segment.href),
    ['http://127.0.0.1:4101/segments/1.m4s', 'http://127.0.0.1:4101/segments/2.m4s']);
  const first = representation.segments[0];
  assert.equal(first.timescale, '1000');
  assert.equal(first.presentationTimeOffset, '500');
  assert.equal(first.timelineT, 500);
  assert.equal(p2.streams[0].timescale, '10');
  assert.equal(p2.streams[0].events[0].id, '7');
  assert.equal(p2.streams[0].events[0].body, 'B');
  assert.deepEqual(unsupported, []);
});

test('缩窗后的清单只声明现存片段，原声明范围仍可从模型区分', () => {
  const { model } = parseManifest(phase1, 'http://127.0.0.1:4101/live');
  const p1 = model.periods.find(period => period.id === 'p1');
  assert.deepEqual(p1.representations[0].segments.map(segment => segment.number), [0]);
  assert.equal(p1.representations[0].segments[0].href, 'http://127.0.0.1:4101/segments/0.m4s');
});

test('静态清单 SegmentList 来源同样可展开', () => {
  const { model } = parseManifest(primary, 'http://127.0.0.1:4101/primary');
  assert.equal(model.type, 'static');
  const segment = model.periods[0].representations[0].segments;
  assert.deepEqual(segment.map(item => item.href),
    ['http://127.0.0.1:4101/segments/p1-1.m4s', 'http://127.0.0.1:4101/segments/p1-2.m4s']);
  assert.equal(model.periods[0].streams[0].events[0].presentationTime, '10000');
});

test('emsg v0/v1 原件字段与载荷完整保留', async () => {
  const v0bytes = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
  const v1bytes = await readFile(new URL('../fixtures/resource-03.bin', import.meta.url));
  const [{ events: [v0] }] = [parseEmsgBoxes(v0bytes)];
  const { events: [v1], errors } = parseEmsgBoxes(v1bytes);
  assert.deepEqual(errors, []);
  assert.equal(v0.version, 0);
  assert.equal(v0.schemeIdUri, 'urn:demo:ad');
  assert.equal(v0.value, 'break');
  assert.equal(v0.timescale, 1000);
  assert.equal(v0.presentationTimeDelta, '500');
  assert.equal(v0.eventDuration, '1000');
  assert.equal(v0.id, '7');
  assert.equal(v0.payloadUtf8, '{"cue":"A"}');
  assert.equal(v1.version, 1);
  assert.equal(v1.presentationTime, '10500');
  assert.equal(v1.payloadBase64, Buffer.from('{"cue":"A"}').toString('base64'));
});

test('v0 依据片段最早呈现时间换算，保留 timescale 与偏移依据', () => {
  const carrier = { timescale: '1000', timescaleValue: 1000,
    presentationTimeOffset: '500', presentationTimeOffsetValue: 500,
    timelineT: 500, number: 1 };
  const timing = deriveTiming({ version: 0, timescale: 1000, presentationTimeDelta: '500' }, carrier);
  assert.equal(timing.resolvable, true);
  assert.equal(timing.periodRelativeUnits.seconds, '500');
  assert.equal(timing.periodRelativeSeconds.seconds, '0.5');
  assert.equal(timing.presentationTimeOffset, '500');
});

test('v1 按事件 timescale 解释绝对 media timeline', () => {
  const carrier = { timescale: '1000', timescaleValue: 1000,
    presentationTimeOffset: '500', presentationTimeOffsetValue: 500,
    timelineT: 10500, number: 2 };
  const timing = deriveTiming({ version: 1, timescale: 1000, presentationTime: '10500' }, carrier);
  assert.equal(timing.periodRelativeUnits.seconds, '10500');
  assert.equal(timing.periodRelativeSeconds.seconds, '10.5');
});

test('v0 缺少片段时间线 t 时不捏造换算结果', () => {
  const carrier = { timescale: '1000', timescaleValue: 1000,
    presentationTimeOffset: '0', presentationTimeOffsetValue: 0,
    timelineT: null, number: 1 };
  const timing = deriveTiming({ version: 0, timescale: 1000, presentationTimeDelta: '500' }, carrier);
  assert.equal(timing.resolvable, false);
  assert.equal(timing.reason, 'carrier_has_no_timeline_t');
});

test('非 emsg box 不产生事件，畸形 box 边界被拒绝', () => {
  assert.deepEqual(parseEmsgBoxes(Buffer.from([0, 0, 0, 8, 109, 111, 111, 118])).events, []);
  assert.throws(() => parseEmsgBoxes(Buffer.from([0, 0, 0, 9, 101, 109, 115, 103])), /mp4_box_size/);
});

test('不支持的 emsg 版本显式报错而非按已知版本误读，且不影响同片段其它 box', async () => {
  const good = Buffer.from([0, 0, 0, 12, 101, 109, 115, 103, 2, 0, 0, 0]);
  const parsed = parseEmsgBoxes(good);
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.errors[0].reason, 'emsg_version_2');
  const validV0 = Buffer.concat([
    good,
    await readFile(new URL('../fixtures/resource-02.bin', import.meta.url)),
  ]);
  const mixed = parseEmsgBoxes(validV0);
  assert.equal(mixed.events.length, 1);
  assert.equal(mixed.errors.length, 1);
});

test('根节点不是 MPD 时拒绝解释', () => {
  assert.throws(() => parseManifest(Buffer.from('<x/>'), 'http://x/y'), /mpd_root/);
  void local;
});

test('未支持的模板声明进入 unsupported，不静默转换成空片段列表', () => {
  const timeTemplate = Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period id="p1"><AdaptationSet><Representation id="v1"><SegmentTemplate media="seg/$Time$.m4s" timescale="1000"><SegmentTimeline><S t="0" d="100" r="0"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>');
  const timeModel = parseManifest(timeTemplate, 'http://x/live');
  assert.equal(timeModel.model.periods[0].representations[0].segments.length, 0);
  assert.ok(timeModel.unsupported[0].includes('template_token:Time'));
  const noTimeline = Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period id="p1"><AdaptationSet><Representation id="v1"><SegmentTemplate media="seg/$Number$.m4s" timescale="1000"/></Representation></AdaptationSet></Period></MPD>');
  const noTimelineModel = parseManifest(noTimeline, 'http://x/live');
  assert.ok(noTimelineModel.unsupported[0].includes('template_without_timeline'));
});

test('BaseURL 沿层级解析，片段地址相对 Period BaseURL', () => {
  const bytes = Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><BaseURL>http://cdn.test/base/</BaseURL><Period id="p1"><AdaptationSet><Representation id="v1"><SegmentList timescale="1000"><SegmentURL media="a/1.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>');
  const { model } = parseManifest(bytes, 'http://cdn.test/live');
  assert.equal(model.periods[0].representations[0].segments[0].href,
    'http://cdn.test/base/a/1.m4s');
});
