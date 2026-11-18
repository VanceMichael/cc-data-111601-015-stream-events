import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// EventHarbor 的持久状态。与通用收件 index.json 分开存放，避免把“单件已保存”
// 误读成“事件已完整”。所有写入串行并原子替换，保证刷新/重启后仍可解释观察范围。
const EMPTY = () => ({
  version: 1,
  source: null,
  observations: [], // 每次看到的 MPD 版本（含未变化的 304 复核）
  periods: [],      // 每个 Period 身份及其各版本锚点快照
  coverage: [],     // 每个被清单声明的片段来源及其观察状态
  events: [],       // 已确认观察到的事件（原件级去重）
});

export class HarborStore {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      await this.read();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.write(EMPTY());
    }
    return this;
  }

  file() { return join(this.directory, 'harbor.json'); }

  async read() {
    return JSON.parse(await readFile(this.file(), 'utf8'));
  }

  async write(state) {
    const temporary = join(this.directory, `harbor-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value));
    await rename(temporary, this.file());
  }

  // 串行化的状态变更；mutator 返回需要持久化的新状态（同对象引用即可）。
  async mutate(mutator) {
    const operation = this.pending.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.write(state);
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async snapshot() {
    return this.mutate(state => state);
  }
}

// 仅按 Period 身份索引锚点快照；同一 id 但起点不同会显式记录冲突，
// 不把旧 Period 的事件悄悄搬到新时间轴上。
export function reconcilePeriod(state, period, observationId) {
  let record = state.periods.find(item => item.periodId === period.id);
  const startRaw = period.start?.raw ?? null;
  if (!record) {
    record = { periodId: period.id, firstObservation: observationId,
      anchors: [{ observationId, start: period.start, duration: period.duration }],
      anchorConflict: false };
    state.periods.push(record);
    return record;
  }
  const last = record.anchors.at(-1);
  if ((last.start?.raw ?? null) !== startRaw) {
    record.anchors.push({ observationId, start: period.start, duration: period.duration });
    record.anchorConflict = true;
  }
  return record;
}

export function findCoverage(state, url) {
  return state.coverage.find(item => item.url === url);
}
