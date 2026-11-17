import { createHash, randomUUID } from 'node:crypto';
import { acquire } from './transport.mjs';
import { parseManifest } from './manifest.mjs';
import { parseEmsgBoxes, deriveTiming } from './emsg.mjs';

export function emptyHarvest(source) {
  return {
    schema: 'event-harbor/harvest/v1',
    source,
    cycles: [],
    periods: [],
    events: [],
  };
}

function periodKey(period) {
  return JSON.stringify({ id: period.id, index: period.index, start: period.start });
}

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function eventKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// 纯状态转移：给定上一轮观察状态与本轮清单快照，产出新状态。不做 I/O，便于直接核对语义。
export function applyCycle(state, cycle) {
  const next = structuredClone(state);
  next.cycles.push({ id: cycle.id, at: cycle.at, manifestHref: cycle.manifestHref,
    manifestDigest: cycle.manifestDigest, type: cycle.type,
    status: cycle.status ?? 'completed',
    reason: cycle.reason ?? null,
    minimumUpdatePeriod: cycle.minimumUpdatePeriod ?? null,
    unsupported: cycle.unsupported ?? [],
    segmentFailures: cycle.segmentFailures ?? [],
    periodDeclared: cycle.periodDeclared ?? {} });

  for (const period of cycle.periods) {
    let entry = next.periods.find(candidate => candidate.key === period.key);
    if (!entry) {
      entry = { key: period.key, periodId: period.periodId, index: period.index,
        start: period.start, startSeconds: period.startSeconds,
        firstSeenCycle: cycle.id, lastSeenCycle: cycle.id,
        streams: [], segments: [], declaredSegmentHrefs: [], observedSegmentHrefs: [] };
      next.periods.push(entry);
    }
    entry.lastSeenCycle = cycle.id;
    entry.startSeconds = period.startSeconds;

    for (const stream of period.streams) {
      let streamEntry = entry.streams.find(candidate =>
        candidate.scheme === stream.scheme && candidate.value === stream.value
        && candidate.timescale === stream.timescale);
      if (!streamEntry) {
        streamEntry = { scheme: stream.scheme, value: stream.value, timescale: stream.timescale,
          firstSeenCycle: cycle.id, observedEventKeys: [] };
        entry.streams.push(streamEntry);
      }
      for (const event of stream.events) {
        const key = eventKey(['mpd', next.source, period.key, stream.scheme, stream.value,
          stream.timescale, event.id, event.presentationTime, event.body]);
        let existing = next.events.find(candidate => candidate.key === key);
        if (!existing) {
          existing = {
            key, layer: 'mpd-eventstream', source: next.source,
            periodKey: period.key, periodId: period.periodId, periodStart: period.start,
            scheme: stream.scheme, value: stream.value, timescale: stream.timescale,
            eventId: event.id, presentationTime: event.presentationTime,
            duration: event.duration, position: { presentationTime: event.presentationTime },
            payload: { kind: 'xml-text', body: event.body, attrs: event.attrs },
            observedIn: [], variants: [],
          };
          next.events.push(existing);
        }
        if (!existing.observedIn.includes(cycle.id)) existing.observedIn.push(cycle.id);
        if (!streamEntry.observedEventKeys.includes(key)) streamEntry.observedEventKeys.push(key);
      }
    }

    for (const href of period.declaredSegmentHrefs) {
      if (!entry.declaredSegmentHrefs.includes(href)) entry.declaredSegmentHrefs.push(href);
    }
    for (const removed of entry.declaredSegmentHrefs.filter(href =>
      !period.declaredSegmentHrefs.includes(href))) {
      if (!entry.shrunkFromCycle) entry.shrunkFromCycle = cycle.id;
      if (!entry.removedSegmentHrefs) entry.removedSegmentHrefs = [];
      if (!entry.removedSegmentHrefs.includes(removed)) entry.removedSegmentHrefs.push(removed);
    }

    for (const observation of period.segmentObservations ?? []) {
      let ledger = entry.segments.find(candidate => candidate.href === observation.href);
      if (!ledger) {
        ledger = { href: observation.href, number: observation.number,
          kind: observation.kind, timelineT: observation.timelineT,
          duration: observation.duration, timescale: observation.timescale,
          presentationTimeOffset: observation.presentationTimeOffset,
          firstSeenCycle: cycle.id, statuses: [], digests: [], emsgKeys: [] };
        entry.segments.push(ledger);
      }
      ledger.lastSeenCycle = cycle.id;
      const previousStatus = ledger.statuses.at(-1);
      if (!previousStatus || previousStatus.status !== observation.status
        || previousStatus.reason !== (observation.reason ?? null)) {
        ledger.statuses.push({ cycle: cycle.id, status: observation.status,
          reason: observation.reason ?? null });
      } else {
        previousStatus.cycle = cycle.id;
      }
      ledger.lastStatus = observation.status;
      if (observation.digest && !ledger.digests.includes(observation.digest)) {
        ledger.digests.push(observation.digest);
      }
      if (observation.emsgErrors?.length) {
        ledger.emsgErrors = [...(ledger.emsgErrors ?? []),
          ...observation.emsgErrors.map(error => ({ cycle: cycle.id, ...error }))];
      }
      if (observation.status === 'fetched' && !entry.observedSegmentHrefs.includes(observation.href)) {
        entry.observedSegmentHrefs.push(observation.href);
      }
      for (const emsg of observation.emsgEvents ?? []) {
        const key = eventKey(['emsg', next.source, period.key, emsg.schemeIdUri, emsg.value,
          emsg.timescale, emsg.id, emsg.version === 0 ? emsg.presentationTimeDelta
            : emsg.presentationTime, observation.href, emsg.boxOffset]);
        let existing = next.events.find(candidate => candidate.key === key);
        if (!existing) {
          existing = {
            key, layer: 'emsg', source: next.source,
            periodKey: period.key, periodId: period.periodId, periodStart: period.start,
            carrier: { href: observation.href, digest: observation.digest,
              number: observation.number, kind: observation.kind,
              timelineT: observation.timelineT, timescale: observation.timescale,
              presentationTimeOffset: observation.presentationTimeOffset,
              boxOffset: emsg.boxOffset, boxSize: emsg.boxSize },
            scheme: emsg.schemeIdUri, value: emsg.value, timescale: String(emsg.timescale),
            emsgVersion: emsg.version, eventId: emsg.id,
            eventDuration: emsg.eventDuration,
            position: emsg.version === 0
              ? { presentationTimeDelta: emsg.presentationTimeDelta }
              : { presentationTime: emsg.presentationTime },
            timing: emsg.timing,
            payload: { kind: 'emsg-bytes', base64: emsg.payloadBase64, utf8: emsg.payloadUtf8 },
            observedIn: [], variants: [],
          };
          next.events.push(existing);
        }
        if (!existing.observedIn.includes(cycle.id)) existing.observedIn.push(cycle.id);
        if (observation.digest && !existing.variants.includes(observation.digest)) {
          existing.variants.push(observation.digest);
        }
        if (!ledger.emsgKeys.includes(key)) ledger.emsgKeys.push(key);
      }
    }
  }
  return next;
}

// 已观察范围说明：区分已声明/已领取/缺失，缺失绝不表述成“没有事件”。
export function coverage(state) {
  // 清单不可用的周期不携带窗口声明，回退到最近一个有效周期，避免把缺口误判为已移出窗口。
  const latest = [...state.cycles].reverse().find(cycle => cycle.status !== 'manifest_unavailable');
  return state.periods.map(period => {
    const declaredNow = latest ? latestPeriodDeclared(latest, period.key) : [];
    const missing = period.segments
      .filter(segment => segment.lastStatus !== 'fetched')
      .map(segment => ({ href: segment.href, number: segment.number,
        lastStatus: segment.lastStatus,
        lastReason: segment.statuses.at(-1)?.reason ?? null,
        declaredInCurrentWindow: declaredNow.includes(segment.href) }));
    const unobserved = declaredNow.filter(href => !period.observedSegmentHrefs.includes(href)
      && !period.segments.some(segment => segment.href === href));
    return {
      periodKey: period.key, periodId: period.periodId, periodStart: period.start,
      firstSeenCycle: period.firstSeenCycle, lastSeenCycle: period.lastSeenCycle,
      windowShrunk: Boolean(period.shrunkFromCycle),
      shrunkFromCycle: period.shrunkFromCycle ?? null,
      removedSegmentHrefs: period.removedSegmentHrefs ?? [],
      declaredCountTotal: period.declaredSegmentHrefs.length,
      observedCount: period.observedSegmentHrefs.length,
      missingOrUnverified: missing,
      declaredButNotYetAttempted: unobserved,
      eventCount: state.events.filter(event => event.periodKey === period.key).length,
    };
  });
}

function latestPeriodDeclared(cycle, periodKey) {
  return cycle.periodDeclared?.[periodKey] ?? [];
}

export class Harvester {
  constructor({ source, store, state }) {
    this.source = source;
    this.store = store;
    this.state = state ?? emptyHarvest(source);
    this.queue = Promise.resolve();
  }

  async harvest({ path } = {}) {
    const operation = this.queue.then(() => this.run(path ?? '/live'));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async run(manifestPath) {
    const id = randomUUID();
    const at = new Date().toISOString();
    let manifest;
    try {
      manifest = await acquire(this.source, manifestPath);
    } catch (error) {
      // 清单本身缺失：登记来源缺口，不生成“无事件”结论，状态不前进。
      const failed = structuredClone(this.state);
      failed.cycles.push({ id, at, manifestHref: new URL(manifestPath, this.source).href,
        manifestDigest: null, type: null, status: 'manifest_unavailable',
        reason: error.message, periods: [], unsupported: [], segmentFailures: [] });
      this.state = failed;
      await this.persist();
      return { id, status: 'manifest_unavailable', reason: error.message };
    }
    const manifestHref = new URL(manifestPath, this.source).href;
    const { model, unsupported } = parseManifest(manifest.bytes, manifestHref);
    const manifestDigest = digestOf(manifest.bytes);
    await this.store.accept(manifest.bytes, manifestHref, { kind: 'mpd-manifest', type: model.type });

    const cycle = { id, at, manifestHref, manifestDigest, type: model.type,
      minimumUpdatePeriod: model.minimumUpdatePeriod, unsupported,
      periods: [], periodDeclared: {}, segmentFailures: [] };

    for (const period of model.periods) {
      const key = periodKey(period);
      const observations = [];
      const declaredHrefs = [...new Set(period.representations.flatMap(representation =>
        representation.segments.map(segment => segment.href)))];
      cycle.periodDeclared[key] = declaredHrefs;
      const carriers = period.representations.flatMap(representation =>
        representation.segments.map(segment => ({ segment, representation })));
      const seenHrefs = new Set();
      for (const { segment } of carriers) {
        if (seenHrefs.has(segment.href)) continue;
        seenHrefs.add(segment.href);
        const observation = { href: segment.href, number: segment.number, kind: segment.kind,
          timelineT: segment.timelineT, duration: segment.duration,
          timescale: segment.timescale, presentationTimeOffset: segment.presentationTimeOffset,
          status: 'unknown', emsgEvents: [] };
        try {
          const fetched = await acquire(this.source, segment.href);
          const digest = digestOf(fetched.bytes);
          await this.store.accept(fetched.bytes, segment.href, { kind: 'fmp4-segment' });
          observation.status = 'fetched';
          observation.digest = digest;
          const parsedBoxes = parseEmsgBoxes(fetched.bytes);
          observation.emsgErrors = parsedBoxes.errors;
          if (parsedBoxes.errors.length) {
            for (const item of parsedBoxes.errors) {
              cycle.segmentFailures.push({ href: segment.href, reason: `emsg:${item.reason}`,
                boxOffset: item.boxOffset });
            }
          }
          observation.emsgEvents = parsedBoxes.events.map(emsg => ({
            ...emsg, timing: deriveTiming(emsg, segment) }));
        } catch (error) {
          observation.status = 'unavailable';
          observation.reason = error.message;
          cycle.segmentFailures.push({ href: segment.href, reason: error.message });
        }
        observations.push(observation);
      }
      cycle.periods.push({
        key, periodId: period.id, index: period.index, start: period.start,
        startSeconds: period.startSeconds,
        streams: period.streams.map(stream => ({
          scheme: stream.scheme, value: stream.value, timescale: stream.timescale,
          events: stream.events.map(event => ({ id: event.id,
            presentationTime: event.presentationTime, body: event.body, attrs: event.attrs })),
        })),
        declaredSegmentHrefs: declaredHrefs,
        segmentObservations: observations,
      });
    }

    this.state = applyCycle(this.state, cycle);
    await this.persist();
    return { id, status: 'completed', manifestDigest,
      periods: cycle.periods.map(period => ({ key: period.key, periodId: period.periodId,
        declared: period.declaredSegmentHrefs.length,
        fetched: period.segmentObservations.filter(item => item.status === 'fetched').length,
        unavailable: period.segmentObservations.filter(item => item.status === 'unavailable').length })),
      segmentFailures: cycle.segmentFailures, unsupported };
  }

  async persist() {
    await this.store.saveHarvest(this.state);
  }
}
