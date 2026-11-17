import { parseXml, local, descendants, content } from './xml.mjs';

// ISO 8601 duration，交换范围限定秒/分/小时；返回数字秒并保留原件字符串。
export function parseDuration(text) {
  if (text == null) return null;
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

// 沿 MPD/Period/AdaptationSet/Representation 解析 BaseURL，缺省回到领取地址。
export function resolveBase(baseHref, chain) {
  let href = baseHref;
  for (const node of chain) {
    const base = node.children.find(child => local(child) === 'BaseURL');
    if (base) href = new URL(content(base).trim(), href).href;
  }
  return href;
}

function templateNode(representation, adaptationSet) {
  return descendants(representation, 'SegmentTemplate')[0]
    ?? descendants(adaptationSet, 'SegmentTemplate')[0] ?? null;
}

function listNode(representation, adaptationSet) {
  return descendants(representation, 'SegmentList')[0]
    ?? descendants(adaptationSet, 'SegmentList')[0] ?? null;
}

export function fillNumber(template, number) {
  if (/\$Number(?:%0\d+d)?\$/.test(template) === false) return null;
  return template.replace(/\$Number(?:%0(\d+)d)?\$/, (_, width) =>
    width ? String(number).padStart(Number(width), '0') : String(number));
}

function fillMedia(template, number, representationId) {
  let media = template;
  if (/\$Time\$/.test(media) || /\$Bandwidth\$/.test(media)) {
    return { unsupported: `template_token:${/\$Time\$/.test(media) ? 'Time' : 'Bandwidth'}` };
  }
  media = media.replaceAll('$RepresentationID$', encodeURIComponent(representationId));
  const filled = fillNumber(media, number);
  if (filled === null) return { unsupported: 'template_without_number' };
  return { media: filled };
}

// SegmentTimeline：S t/d/r（r>=0）展开为 (number, t, d) 序列。
export function expandTimeline(node, startNumber) {
  const entries = [];
  let number = startNumber;
  let nextTime = null;
  for (const segment of node.children.filter(child => local(child) === 'S')) {
    const d = Number(segment.attrs.d);
    if (!Number.isFinite(d) || d <= 0) { entries.push({ unsupported: 'timeline_d' }); continue; }
    const r = Number(segment.attrs.r ?? 0);
    if (!Number.isInteger(r) || r < 0) { entries.push({ unsupported: 'timeline_r' }); continue; }
    let t = segment.attrs.t != null ? Number(segment.attrs.t) : nextTime;
    if (!Number.isFinite(t)) { entries.push({ unsupported: 'timeline_t' }); continue; }
    for (let index = 0; index <= r; index += 1) {
      entries.push({ number, t, d });
      nextTime = t + d;
      t += d;
      number += 1;
    }
  }
  return entries;
}

function buildSegment({ href, node, number, t, d, kind }) {
  const timescale = Number(node.attrs.timescale ?? 1);
  const presentationTimeOffset = Number(node.attrs.presentationTimeOffset ?? 0);
  return {
    kind,
    href,
    number,
    timelineT: t,
    duration: d,
    durationRaw: node.attrs.duration ?? null,
    timescale: node.attrs.timescale ?? '1',
    timescaleValue: Number.isFinite(timescale) && timescale > 0 ? timescale : 1,
    presentationTimeOffset: node.attrs.presentationTimeOffset ?? '0',
    presentationTimeOffsetValue: Number.isFinite(presentationTimeOffset) ? presentationTimeOffset : 0,
  };
}

function buildRepresentation({ representation, adaptationSet, periodBase, unsupported }) {
  const repBase = resolveBase(periodBase, [adaptationSet, representation]);
  const id = representation.attrs.id ?? null;
  const template = templateNode(representation, adaptationSet);
  const list = listNode(representation, adaptationSet);
  const segments = [];
  if (template) {
    const media = template.attrs.media;
    const timelineNode = template.children.find(child => local(child) === 'SegmentTimeline');
    if (!media) unsupported.push(`representation:${id ?? '?'}:template_without_media`);
    else if (!timelineNode) unsupported.push(`representation:${id ?? '?'}:template_without_timeline`);
    else {
      const startNumber = Number(template.attrs.startNumber ?? 1);
      if (!Number.isInteger(startNumber)) { unsupported.push(`representation:${id ?? '?'}:start_number`); }
      else for (const entry of expandTimeline(timelineNode, startNumber)) {
        if (entry.unsupported) { unsupported.push(`representation:${id ?? '?'}:${entry.unsupported}`); continue; }
        const filled = fillMedia(media, entry.number, id ?? '');
        if (filled.unsupported) { unsupported.push(`representation:${id ?? '?'}:${filled.unsupported}`); continue; }
        segments.push(buildSegment({ href: new URL(filled.media, repBase).href, node: template,
          number: entry.number, t: entry.t, d: entry.d, kind: 'SegmentTemplate' }));
      }
    }
  } else if (list) {
    const urls = descendants(list, 'SegmentURL');
    urls.forEach((url, index) => {
      if (!url.attrs.media) { unsupported.push(`representation:${id ?? '?'}:segmenturl_without_media`); return; }
      segments.push(buildSegment({ href: new URL(url.attrs.media, repBase).href, node: list,
        number: index + 1, t: null, d: url.attrs.duration != null ? Number(url.attrs.duration)
          : (list.attrs.duration != null ? Number(list.attrs.duration) : null),
        kind: 'SegmentList' }));    });
  } else {
    unsupported.push(`representation:${id ?? '?'}:no_segment_source`);
  }
  return { id, segmentBase: repBase, segments };
}

function buildStream(stream) {
  return {
    scheme: stream.attrs.schemeIdUri ?? '',
    value: stream.attrs.value ?? null,
    timescale: stream.attrs.timescale ?? '1',
    timescaleValue: Number(stream.attrs.timescale ?? 1) || 1,
    events: stream.children.filter(node => local(node) === 'Event').map(event => ({
      attrs: { ...event.attrs },
      id: event.attrs.id ?? null,
      presentationTime: event.attrs.presentationTime ?? null,
      duration: event.attrs.duration ?? null,
      body: content(event),
    })),
  };
}

function buildPeriod(period, index, manifestHref, unsupported) {
  const periodBase = resolveBase(manifestHref, [period]);
  const adaptationSets = period.children.filter(node => local(node) === 'AdaptationSet');
  const representations = adaptationSets.flatMap(adaptationSet =>
    adaptationSet.children.filter(node => local(node) === 'Representation')
      .map(representation => buildRepresentation({
        representation, adaptationSet, periodBase, unsupported })));
  return {
    index,
    id: period.attrs.id ?? null,
    start: period.attrs.start ?? null,
    startSeconds: parseDuration(period.attrs.start),
    base: periodBase,
    streams: descendants(period, 'EventStream').map(buildStream),
    representations,
  };
}

export function parseManifest(bytes, manifestHref) {
  const unsupported = [];
  const root = parseXml(bytes);
  if (local(root) !== 'MPD') throw new Error('mpd_root');
  const manifestBase = resolveBase(manifestHref, [root]);
  const periods = descendants(root, 'Period').map((period, index) =>
    buildPeriod(period, index, manifestBase, unsupported));
  const model = {
    type: root.attrs.type ?? 'static',
    minimumUpdatePeriod: root.attrs.minimumUpdatePeriod ?? null,
    minimumUpdatePeriodSeconds: parseDuration(root.attrs.minimumUpdatePeriod),
    mediaPresentationDuration: root.attrs.mediaPresentationDuration ?? null,
    mediaPresentationDurationSeconds: parseDuration(root.attrs.mediaPresentationDuration),
    base: manifestBase,
    periods,
    unsupported,
  };
  return { model, unsupported };
}
