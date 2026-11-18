// 动态清单事件采集引擎：跟随 MPD 的 Period 与片段时间线领取来源，
// 解释 EventStream 与片段内 emsg，并把“观察到的范围”与“已确认事件”分开持久化。
import { createHash, randomUUID } from 'node:crypto';
import { acquire } from './transport.mjs';
import { planManifest, plannedSegments } from './manifest.mjs';
import { eventMessages } from './reader.mjs';
import { interpretEmsg, interpretStreamEvent, emsgKey, streamEventKey } from './timeline.mjs';
import { HarborStore, reconcilePeriod, findCoverage } from './harbor-store.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const newId = () => randomUUID();

export async function createHarbor({ source, directory, store }) {
  const harborStore = store ?? await new HarborStore(directory).initialize();
  const state = await harborStore.read();
  if (state.source !== source) {
    state.source = source;
    await harborStore.write(state);
  }
  return new Harbor({ source, store: harborStore });
}

export class Harbor {
  constructor({ source, store }) {
    this.source = source;
    this.store = store;
  }

  // 执行一次跟随采集：领 MPD（带条件复核）→ 解释 Period/片段 → 补领新片段。
  // 单个来源失败只影响对应 coverage 状态，绝不生成“无事件”的结论。
  async cycle(manifestPath) {
    const manifestUrl = new URL(manifestPath, this.source).href;
    const current = await this.store.read();
    const previous = current.observations.findLast(item => item.url === manifestUrl);
    const headers = previous?.etag ? { 'If-None-Match': previous.etag } : {};
    let fetched;
    try {
      fetched = await acquire(this.source, manifestPath, headers);
    } catch (error) {
      const observation = { id: newId(), kind: 'manifest-fetch-error', path: manifestPath,
        url: manifestUrl,
        at: new Date().toISOString(), error: error.message };
      await this.store.mutate(state => state.observations.push(observation));
      return { changed: false, observation, error: error.message };
    }

    if (fetched.status === 304) {
      if (!previous || previous.kind !== 'manifest') {
        // 没有可复核的本地清单却收到 304：来源行为异常，显式留痕而不是假装一致。
        const observation = { id: newId(), kind: 'manifest-fetch-error', path: manifestPath,
          url: manifestUrl, at: new Date().toISOString(), error: 'unexpected_304_without_manifest' };
        await this.store.mutate(state => state.observations.push(observation));
        return { changed: false, observation, error: observation.error };
      }
      const observation = { id: newId(), kind: 'manifest-not-modified', path: manifestPath,
        url: manifestUrl,
        at: new Date().toISOString(), etag: fetched.etag ?? previous.etag,
        revalidates: previous.id };
      await this.store.mutate(state => state.observations.push(observation));
      // 304 只表示清单字节未变；迟到片段仍可能在窗口内到达，重试未成功来源。
      const segmentResults = [];
      for (const coverage of await this.#pendingSegments(previous.segmentUrls ?? [])) {
        segmentResults.push(await this.#collectSegment(this.#toSegmentRef(coverage)));
      }
      return { changed: false, observation, segments: segmentResults };
    }

    const manifestBytes = fetched.bytes;
    const manifestDigest = digest(manifestBytes);
    // 字节摘要是变化判定的唯一权威；ETag/304 只是省流量的复核建议。
    // 只要历史上观察过相同字节（哪怕中间隔了别的版本），即视为重复发布。
    const unchanged = current.observations.some(item =>
      item.url === manifestUrl && item.kind === 'manifest' && item.digest === manifestDigest);
    const plan = planManifest(manifestBytes, manifestUrl);
    const observation = {
      id: newId(), kind: 'manifest', path: manifestPath,
      url: manifestUrl,
      at: new Date().toISOString(), digest: manifestDigest, etag: fetched.etag,
      type: plan.type,
      periodIds: plan.periods.map(period => period.id),
      segmentUrls: plannedSegments(plan).map(segment => segment.url),
      repeatedBytes: unchanged,
    };
    const summary = await this.store.mutate(state => {
      state.observations.push(observation);
      const periods = plan.periods.map(period => reconcilePeriod(state, period, observation.id));
      this.#ingestStreamEvents(state, plan, observation.id);
      const segments = plannedSegments(plan);
      for (const segment of segments) {
        const period = plan.periods.find(item => item.id === segment.periodId);
        this.#declareCoverage(state, segment, observation.id, period?.start ?? null);
      }
      // 清单缩窗：本轮 MPD 不再列出的来源分两种解释——
      // 已领取（fetched/unparseable）的保留事实只标记 out-of-window，事件不动；
      // 从未领到的标记 withheld，明确“窗口已过且未观察到”，而非“没有事件”。
      const listed = new Set(observation.segmentUrls);
      const outOfWindow = [];
      const withheld = [];
      for (const coverage of state.coverage) {
        if (listed.has(coverage.url)) continue;
        if (coverage.status === 'fetched' || coverage.status === 'unparseable') {
          if (!coverage.outOfWindow) { coverage.outOfWindow = true; coverage.outOfWindowAt = observation.at; }
          outOfWindow.push(coverage.url);
        } else if (!coverage.withheld) {
          coverage.withheld = true;
          coverage.withheldAt = observation.at;
          withheld.push(coverage.url);
        }
      }
      return { observation, periods, segments, withheld, outOfWindow };
    });

    // 片段补放在状态提交之后：本轮未领到的片段保持 expected/unavailable，
    // 下一轮清单仍在窗口内时继续尝试，迟到片段到达后自然补齐。
    // 即便清单字节重复发布，仍按当前窗口重试未成功的来源。
    const segmentResults = [];
    for (const segment of summary.segments) {
      segmentResults.push(await this.#collectSegment(segment));
    }
    return { changed: true, observation: summary.observation,
      periods: summary.periods, withheld: summary.withheld,
      outOfWindow: summary.outOfWindow, segments: segmentResults };
  }

  #declareCoverage(state, segment, observationId, periodAnchor) {
    let coverage = findCoverage(state, segment.url);
    if (!coverage) {
      coverage = {
        url: segment.url,
        source: this.source,
        periodId: segment.periodId,
        periodAnchor,
        representationId: segment.representationId,
        number: segment.number,
        timing: segment.timing,
        timescale: segment.timescale,
        presentationTimeOffset: segment.presentationTimeOffset,
        status: 'expected', // 清单声明但尚未领到；缺来源时不能解释成“没有事件”
        firstObservation: observationId,
        declarations: [],
        attempts: [],
        events: [],
      };
      state.coverage.push(coverage);
    }
    coverage.lastObservation = observationId;
    coverage.withheld = false; // 本轮清单仍包含它，缩窗标记只在清单整体比对时处理
    coverage.outOfWindow = false;
    for (const declaration of segment.declarations) {
      const known = coverage.declarations.some(item =>
        item.observationId === observationId && item.representationId === declaration.representationId
        && item.number === declaration.number && item.periodId === declaration.periodId);
      if (!known) coverage.declarations.push({ ...declaration, observationId });
    }
  }

  #ingestStreamEvents(state, plan, observationId) {
    for (const period of plan.periods) {
      for (const stream of period.streams) {
        for (const event of stream.events) {
          const key = streamEventKey({ source: this.source, periodId: period.id, stream, event });
          if (state.events.some(item => item.key === key)) continue;
          const timing = interpretStreamEvent(event, stream);
          state.events.push({
            id: newId(), key, origin: 'event-stream',
            source: this.source,
            observationId,
            periodId: period.id,
            periodAnchor: period.start,
            scheme: stream.scheme,
            value: stream.value,
            eventId: event.identity.id,
            payload: { body: event.body },
            raw: { ...event, identity: undefined },
            timing,
          });
        }
      }
    }
  }

  async #pendingSegments(urls) {
    const state = await this.store.read();
    return state.coverage.filter(item => urls.includes(item.url)
      && item.status !== 'fetched' && item.status !== 'unparseable');
  }

  // coverage 记录补全为 #collectSegment 需要的片段引用（时间锚点取自 coverage 声明）。
  #toSegmentRef(coverage) {
    return {
      url: coverage.url,
      periodId: coverage.periodId,
      representationId: coverage.representationId,
      number: coverage.number,
      timing: coverage.timing ?? null,
      timescale: coverage.timescale,
      presentationTimeOffset: coverage.presentationTimeOffset,
      declarations: coverage.declarations,
    };
  }

  async #collectSegment(segment) {
    const state = await this.store.read();
    const coverage = findCoverage(state, segment.url);
    if (coverage?.status === 'fetched') {
      return { url: segment.url, status: 'fetched', reused: true, events: coverage.events.length };
    }
    let fetched;
    try {
      fetched = await acquire(this.source, segment.url);
    } catch (error) {
      await this.store.mutate(latest => {
        const item = findCoverage(latest, segment.url);
        if (!item) throw new Error(`coverage_unknown:${segment.url}`);
        item.status = 'unavailable';
        item.attempts.push({ at: new Date().toISOString(), error: error.message });
      });
      return { url: segment.url, status: 'unavailable', error: error.message };
    }

    const bytes = fetched.bytes;
    const segmentDigest = digest(bytes);
    let messages;
    try {
      messages = eventMessages(bytes);
    } catch (error) {
      await this.store.mutate(latest => {
        const item = findCoverage(latest, segment.url);
        if (!item) throw new Error(`coverage_unknown:${segment.url}`);
        item.status = 'unparseable';
        item.attempts.push({ at: new Date().toISOString(), error: error.message });
      });
      return { url: segment.url, status: 'unparseable', error: error.message };
    }

    const events = [];
    await this.store.mutate(latest => {
      const item = findCoverage(latest, segment.url);
      if (!item) throw new Error(`coverage_unknown:${segment.url}`);
      item.status = 'fetched';
      item.digest = segmentDigest;
      item.etag = fetched.etag;
      item.fetchedAt = new Date().toISOString();
      item.attempts.push({ at: item.fetchedAt, status: 200, digest: segmentDigest });
      for (const message of messages) {
        const key = emsgKey({ source: this.source, periodId: segment.periodId,
          event: message, boxOffset: message.boxOffset });
        const timing = interpretEmsg(message, segment);
        const record = {
          id: newId(), key, origin: 'emsg',
          source: this.source,
          periodId: segment.periodId,
          periodAnchor: item.periodAnchor ?? null,
          scheme: message.schemeIdUri,
          value: message.value,
          eventId: String(message.id),
          segmentUrl: segment.url,
          segmentDigest,
          boxOffset: message.boxOffset,
          payload: { messageBase64: message.messageBase64, messageLength: message.messageLength },
          raw: { ...message },
          timing,
        };
        if (!latest.events.some(existing => existing.key === key)) {
          latest.events.push(record);
          item.events.push(key);
        } else if (!item.events.includes(key)) {
          item.events.push(key);
        }
        events.push(record);
      }
      item.emsgCount = messages.length;
    });
    return { url: segment.url, status: 'fetched', digest: segmentDigest,
      emsgCount: messages.length, events: events.map(event => event.key) };
  }
}
