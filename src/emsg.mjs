import { boxes } from './reader.mjs';

class Cursor {
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.offset = start;
    this.end = end;
  }
  u8() { const value = this.bytes[this.offset]; this.offset += 1; return value; }
  u24() { const value = (this.bytes[this.offset] << 16) | (this.bytes[this.offset + 1] << 8)
    | this.bytes[this.offset + 2]; this.offset += 3; return value >>> 0; }
  u32() { const value = this.bytes.readUInt32BE(this.offset); this.offset += 4; return value; }
  u64() { const value = this.bytes.readBigUInt64BE(this.offset); this.offset += 8; return value; }
  cString() {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0 || end >= this.end) throw new Error('emsg_string_terminator');
    const value = this.bytes.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return value;
  }
  rest() { return this.bytes.subarray(this.offset, this.end); }
}

// 只遍历 box 并提取 emsg，不接触音视频样本。单个 box 畸形时显式登记错误，不丢弃同片段其它 box。
export function parseEmsgBoxes(bytes) {
  const events = [];
  const errors = [];
  for (const box of boxes(bytes)) {
    if (box.type !== 'emsg') continue;
    try {
      const cursor = new Cursor(bytes, box.offset + 8, box.offset + box.size);
      const version = cursor.u8();
      const flags = cursor.u24();
      let common;
      if (version === 0) {
        const schemeIdUri = cursor.cString();
        const value = cursor.cString();
        const timescale = cursor.u32();
        const presentationTimeDelta = cursor.u32();
        const eventDuration = cursor.u32();
        const id = cursor.u32();
        common = { version, flags, schemeIdUri, value, timescale,
          presentationTimeDelta: String(presentationTimeDelta),
          eventDuration: String(eventDuration), id: String(id) };
      } else if (version === 1) {
        const timescale = cursor.u32();
        const presentationTime = cursor.u64();
        const eventDuration = cursor.u32();
        const id = cursor.u32();
        const schemeIdUri = cursor.cString();
        const value = cursor.cString();
        common = { version, flags, schemeIdUri, value, timescale,
          presentationTime: presentationTime.toString(),
          eventDuration: String(eventDuration), id: String(id) };
      } else {
        throw new Error(`emsg_version_${version}`);
      }
      const payload = cursor.rest();
      events.push({ ...common, payload, payloadBase64: payload.toString('base64'),
        payloadUtf8: isUtf8(payload) ? payload.toString('utf8') : null,
        boxOffset: box.offset, boxSize: box.size });
    } catch (error) {
      errors.push({ boxOffset: box.offset, boxSize: box.size, reason: error.message });
    }
  }
  return { events, errors };
}

function isUtf8(bytes) {
  try {
    const decoded = Buffer.from(bytes.toString('utf8'), 'utf8');
    return decoded.equals(bytes);
  } catch { return false; }
}

// 保留换算依据：全程 BigInt 有理运算，原件数值不被覆盖。
// v0 delta 相对所载片段在 Period 内的最早呈现时间；v1 presentation_time 为该 timescale 上的绝对 media timeline。
export function deriveTiming(event, carrier) {
  const timescale = BigInt(event.timescale);
  const repTimescale = BigInt(carrier.timescaleValue);
  const offset = BigInt(carrier.presentationTimeOffsetValue);
  const repT = carrier.timelineT == null ? null : BigInt(carrier.timelineT);
  const basis = {
    timescale: event.timescale,
    repTimescale: carrier.timescale,
    presentationTimeOffset: carrier.presentationTimeOffset,
    carrierTimelineT: repT == null ? null : repT.toString(),
    carrierNumber: carrier.number == null ? null : String(carrier.number),
    note: event.version === 0
      ? 'v0: delta relative to the earliest presentation time of the carrying segment within the Period'
      : 'v1: absolute media timeline in the event timescale',
  };
  if (event.version === 0) {
    if (repT == null) {
      return { ...basis, resolvable: false, reason: 'carrier_has_no_timeline_t',
        periodRelativeUnits: null, periodRelativeSeconds: null };
    }
    // ((repT - pto) / repTimescale + delta / timescale) 以事件 timescale 为分母的有理表示
    const rel = repT - offset;
    const unitNumerator = rel * timescale + BigInt(event.presentationTimeDelta) * repTimescale;
    const unitDenominator = repTimescale;
    return { ...basis, resolvable: true,
      periodRelativeUnits: rational(unitNumerator, unitDenominator),
      periodRelativeSeconds: rational(unitNumerator, unitDenominator * timescale) };
  }
  const numerator = BigInt(event.presentationTime);
  return { ...basis, resolvable: true,
    periodRelativeUnits: rational(numerator, 1n),
    periodRelativeSeconds: rational(numerator, timescale) };
}

function rational(numerator, denominator) {
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  const result = { numerator: numerator.toString(), denominator: denominator.toString(),
    units: whole.toString(), seconds: whole.toString(), exact: remainder === 0n };
  if (remainder !== 0n) {
    const digits = (remainder * 1000000000n / denominator).toString().replace(/0+$/, '');
    result.decimal = `${whole}.${digits}`;
    result.seconds = result.decimal;
  }
  return result;
}
