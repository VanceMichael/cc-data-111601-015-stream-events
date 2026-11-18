// 事件时间线解释：把 emsg v0/v1 与 EventStream 事件的原始字段换算到 Period 时间轴，
// 但不丢弃任何原始 timescale、偏移和载荷。换算全部走 BigInt 有理数，可复核。
import { ticksToSeconds, rationalRecord, parseInteger } from './iso.mjs';

function periodSeconds(ticks, timescale) {
  return { ticks: ticks.toString(), timescale: timescale.toString(),
    ...rationalRecord(ticksToSeconds(ticks, timescale)) };
}

// segmentAnchor 来自 manifest 计划：
// { earliestPresentationTime: {ticks, timescale}, timelineT, presentationTimeOffset }
export function interpretEmsg(event, segment) {
  const timescale = BigInt(event.timescale);
  const pto = parseInteger(segment.presentationTimeOffset, 'presentationTimeOffset');
  const timing = {
    emsgTimescale: event.timescale,
    segmentTimescale: segment.timescale,
    presentationTimeOffset: segment.presentationTimeOffset,
    segmentEarliestPresentationTime: segment.timing,
  };
  let periodTicks;
  if (event.version === 0) {
    // DASH-IF：v0 presentation_time_delta 相对“所载片段在该 Period 的最早呈现时间”。
    if (!segment.timing) throw new Error('segment_anchor_required_for_emsg_v0');
    const earliest = BigInt(segment.timing.ticks); // 已位于 Period 时间轴（t - PTO）
    periodTicks = earliest + BigInt(event.presentationTimeDelta);
    timing.emsgPresentationTimeDelta = String(event.presentationTimeDelta);
    timing.rule = 'v0_delta_plus_segment_earliest_presentation_time';
  } else {
    // v1 presentation_time 是事件自身 timescale 下的绝对媒体时间，
    // 落到 Period 时间轴时按该表示的 PTO 回退（DASH-IF 时间模型）。
    periodTicks = BigInt(event.presentationTime) - pto;
    timing.emsgPresentationTime = event.presentationTime;
    timing.rule = 'v1_presentation_time_minus_presentation_time_offset';
  }
  timing.periodPresentationTime = periodSeconds(periodTicks, timescale);
  return timing;
}

// EventStream 事件：presentationTime 直接位于 Period 时间轴，沿用声明的 timescale。
export function interpretStreamEvent(event, stream) {
  const timescaleRaw = stream.timescale;
  const timescale = parseInteger(timescaleRaw, 'timescale');
  const presentation = event.presentationTime === null ? null
    : periodSeconds(parseInteger(event.presentationTime, 'presentationTime'), timescale);
  const duration = event.duration === null ? null
    : (() => { const rational = ticksToSeconds(parseInteger(event.duration, 'duration'), timescale);
      return { ticks: event.duration, timescale: timescaleRaw, ...rationalRecord(rational) }; })();
  return {
    streamTimescale: timescaleRaw,
    periodPresentationTime: presentation,
    duration,
    rule: 'event_stream_presentation_time_on_period_timeline',
  };
}

// 事件身份：至少区分节目来源、Period、scheme/value、id/呈现位置。
// 同一 event id 在不同 Period 或方案下不视为同一事件。
export function emsgKey({ source, periodId, event, boxOffset }) {
  return [
    `src=${source}`,
    `period=${periodId ?? ''}`,
    `scheme=${event.schemeIdUri ?? ''}`,
    `value=${event.value ?? ''}`,
    `id=${event.id}`,
    `v=${event.version}`,
    `t=${event.version === 0 ? event.presentationTimeDelta : event.presentationTime}`,
    `box=${boxOffset}`,
  ].join('|');
}

export function streamEventKey({ source, periodId, stream, event }) {
  return [
    `src=${source}`,
    `period=${periodId ?? ''}`,
    `scheme=${stream.scheme ?? ''}`,
    `value=${stream.value ?? ''}`,
    `id=${event.identity.id ?? ''}`,
    `ord=${event.identity.ordinal}`,
    `pt=${event.presentationTime ?? ''}`,
  ].join('|');
}
