// 把 DASH MPD 解释成可跟随的采集计划：Period 锚点、EventStream 原声明、
// 每个 Representation 的片段编号/媒体地址/时间线锚点。
// 仅覆盖 docs/upstream.md 约定的子集：BaseURL、SegmentList、SegmentTemplate
// 的 $Number$ 与 SegmentTimeline(S t/d/r, r>=0)、timescale、presentationTimeOffset。
import { parseXml, local, descendants, content } from './xml.mjs';
import { parseDuration, parseInteger, expandTimeline, applyTemplate, ticksToSeconds, rationalRecord } from './iso.mjs';
const safeDuration = raw => {
  const parsed = parseDuration(raw);
  return { raw, ...rationalRecord(parsed.seconds) };
};

function findChild(node, name) {
  return node.children.find(child => local(child) === name) ?? null;
}
function findAll(node, name) {
  return node.children.filter(child => local(child) === name);
}
// SegmentTemplate/SegmentList 可在 Representation、AdaptationSet、Period 各层声明并继承。
function nearest(node, name) {
  let current = node;
  while (current && current.name !== '#document') {
    const found = findChild(current, name);
    if (found) return found;
    current = current.parent;
  }
  return null;
}

function linkParents(node, parent = null) {
  node.parent = parent;
  for (const child of node.children) linkParents(child, node);
}

// Period 起点：可能是 PTxxS 相对时长，也可能是 ISO 墙钟时间；原值保留，能换算才换算。
function periodAnchor(period) {
  const raw = period.attrs.start ?? null;
  let anchor = null;
  if (raw !== null) {
    if (raw.startsWith('P') || raw.startsWith('-P')) {
      try { anchor = { kind: 'duration', ...safeDuration(raw) }; }
      catch { anchor = { kind: 'unparsed', raw }; }
    } else {
      const epoch = Date.parse(raw);
      anchor = Number.isNaN(epoch) ? { kind: 'unparsed', raw }
        : { kind: 'wallclock', epochMs: epoch, raw };
    }
  }
  const durationRaw = period.attrs.duration ?? null;
  let duration = null;
  if (durationRaw !== null) {
    try { duration = safeDuration(durationRaw); } catch { duration = { raw: durationRaw }; }
  }
  return { start: anchor, duration };
}

function parseEventStream(stream) {
  const timescaleRaw = stream.attrs.timescale ?? '1';
  const timescale = parseInteger(timescaleRaw, 'timescale');
  return {
    scheme: stream.attrs.schemeIdUri ?? null,
    value: stream.attrs.value ?? null,
    timescale: timescaleRaw,
    events: findAll(stream, 'Event').map((event, ordinal) => ({
      id: event.attrs.id ?? null,
      presentationTime: event.attrs.presentationTime ?? null,
      duration: event.attrs.duration ?? null,
      timescale: timescaleRaw,
      body: content(event),
      ordinal,
      // 保留定位依据，供上层区分同一 id 在不同方案/Period 下的语义。
      identity: { scheme: stream.attrs.schemeIdUri ?? null, value: stream.attrs.value ?? null,
        id: event.attrs.id ?? null, ordinal },
    })),
  };
}

function segmentPlan({ periodId, representation, baseUrl, manifestUrl }) {
  const template = nearest(representation, 'SegmentTemplate');
  const list = nearest(representation, 'SegmentList');
  const timescaleRaw = (template ?? list)?.attrs.timescale ?? '1';
  const timescale = parseInteger(timescaleRaw, 'timescale');
  const ptoRaw = (template ?? list)?.attrs.presentationTimeOffset ?? '0';
  const presentationTimeOffset = parseInteger(ptoRaw, 'presentationTimeOffset');
  const resolve = media => new URL(media, new URL(baseUrl, manifestUrl)).href;
  const segments = [];

  if (template) {
    const timelineNode = findChild(template, 'SegmentTimeline');
    const startNumber = parseInteger(template.attrs.startNumber ?? '0', 'startNumber');
    const mediaPattern = template.attrs.media;
    if (!mediaPattern) throw new Error('segment_template_media_required');
    let points;
    if (timelineNode) {
      const entries = findAll(timelineNode, 'S').map(s => ({ t: s.attrs.t, d: s.attrs.d, r: s.attrs.r }));
      points = expandTimeline(entries, ptoRaw);
    } else {
      // 无 SegmentTimeline 的固定 duration 周期推算不在本交换子集，明确拒绝而不是猜测。
      throw new Error('fixed_duration_template_unsupported');
    }
    points.forEach((point, index) => {
      const number = startNumber + BigInt(index);
      const media = applyTemplate(mediaPattern, { number, representationId: representation.attrs.id });
      segments.push(segmentEntry({ number: number.toString(), media: resolve(media),
        timelineT: point.t, d: point.d, timescale, presentationTimeOffset, timescaleRaw, ptoRaw }));
    });
  } else if (list) {
    const startNumber = parseInteger(list.attrs.startNumber ?? '1', 'startNumber');
    const duration = list.attrs.duration === undefined ? null
      : { ticks: parseInteger(list.attrs.duration, 'duration'), raw: list.attrs.duration };
    const urls = findAll(list, 'SegmentURL');
    urls.forEach((url, index) => {
      const media = url.attrs.media;
      if (!media) throw new Error('segment_url_media_required');
      const number = startNumber + BigInt(index);
      const timelineT = duration ? presentationTimeOffset + duration.ticks * BigInt(index) : null;
      segments.push(segmentEntry({ number: number.toString(), media: resolve(media),
        timelineT, d: duration?.ticks ?? null, timescale, presentationTimeOffset, timescaleRaw, ptoRaw }));
    });
  }
  return {
    representationId: representation.attrs.id ?? null,
    timescale: timescaleRaw,
    presentationTimeOffset: ptoRaw,
    mediaTemplate: template?.attrs.media ?? null,
    segments,
  };
}

function segmentEntry({ number, media, timelineT, d, timescale, presentationTimeOffset, timescaleRaw, ptoRaw }) {
  const entry = {
    number,
    url: media,
    timelineT: timelineT === null ? null : timelineT.toString(),
    d: d === null ? null : d.toString(),
    timescale: timescaleRaw,
    presentationTimeOffset: ptoRaw,
  };
  if (timelineT !== null) {
    // Period 时间轴上的最早呈现时间（秒级有理值），emsg v0 的换算锚点。
    const earliest = timelineT - presentationTimeOffset;
    entry.earliestPresentationTime = { ticks: earliest.toString(), timescale: timescaleRaw,
      ...rationalRecord(ticksToSeconds(earliest, timescale)) };
  }
  return entry;
}

export function planManifest(bytes, manifestUrl) {
  const root = parseXml(bytes);
  if (local(root) !== 'MPD') throw new Error('mpd_root');
  linkParents(root);
  const type = root.attrs.type ?? 'static';
  let minimumUpdatePeriod = null;
  if (root.attrs.minimumUpdatePeriod !== undefined) {
    try { minimumUpdatePeriod = safeDuration(root.attrs.minimumUpdatePeriod); }
    catch { minimumUpdatePeriod = { raw: root.attrs.minimumUpdatePeriod }; }
  }
  const periods = descendants(root, 'Period').map(periodNode => {
    const periodId = periodNode.attrs.id ?? null;
    const anchor = periodAnchor(periodNode);
    const streams = descendants(periodNode, 'EventStream').map(parseEventStream);
    const representations = [];
    for (const representation of descendants(periodNode, 'Representation')) {
      const baseNode = findChild(representation, 'BaseURL')
        ?? nearest(representation, 'BaseURL');
      const baseUrl = baseNode ? content(baseNode) : '';
      representations.push(segmentPlan({ periodId, representation, baseUrl, manifestUrl }));
    }
    return { id: periodId, ...anchor, streams, representations };
  });
  return {
    kind: 'mpd-plan',
    type,
    availabilityStartTime: root.attrs.availabilityStartTime ?? null,
    minimumUpdatePeriod,
    mediaPresentationDuration: root.attrs.mediaPresentationDuration ?? null,
    periods,
  };
}

// 采集计划中出现过的全部去重片段地址（同 URL 只领一次，声明方另行登记）。
export function plannedSegments(plan) {
  const byUrl = new Map();
  for (const period of plan.periods) {
    for (const representation of period.representations) {
      for (const segment of representation.segments) {
        const existing = byUrl.get(segment.url);
        if (existing) {
          existing.declarations.push({ periodId: period.id, representationId: representation.representationId,
            number: segment.number });
        } else {
          byUrl.set(segment.url, { url: segment.url, periodId: period.id,
            representationId: representation.representationId, number: segment.number,
            timing: segment.earliestPresentationTime ?? null, timescale: segment.timescale,
            presentationTimeOffset: segment.presentationTimeOffset,
            declarations: [{ periodId: period.id, representationId: representation.representationId,
              number: segment.number }] });
        }
      }
    }
  }
  return [...byUrl.values()];
}
