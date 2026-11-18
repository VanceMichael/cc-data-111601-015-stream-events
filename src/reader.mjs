import { parseXml, local, descendants } from './xml.mjs';
export function inspect(bytes) {
  const root = parseXml(bytes);
  if (local(root) !== 'MPD') throw new Error('mpd_root');
  return { kind: 'mpd-index', type: root.attrs.type ?? 'static', duration: root.attrs.mediaPresentationDuration ?? null,
    periods: descendants(root, 'Period').map(period => ({ id: period.attrs.id, start: period.attrs.start ?? null,
      segments: descendants(period, 'SegmentURL').map(segment => segment.attrs.media),
      streams: descendants(period, 'EventStream').map(stream => ({ scheme: stream.attrs.schemeIdUri,
        value: stream.attrs.value, timescale: stream.attrs.timescale ?? '1',
        events: stream.children.filter(node => local(node) === 'Event').map(event => ({ ...event.attrs, body: event.text })) })) })) };
}
export function boxes(bytes) {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('mp4_header_short');
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) throw new Error('mp4_header_short');
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('mp4_box_too_large');
      size = Number(large); header = 16;
    } else if (size === 0) {
      size = bytes.length - offset; // 本文件最后一个 box，延伸到字节末尾
    }
    if (size < header || offset + size > bytes.length) throw new Error('mp4_box_size');
    result.push({ type, offset, size, payload: bytes.subarray(offset + header, offset + size) });
    offset += size;
  }
  return result;
}

const CONTAINER_BOXES = new Set(['moov', 'moof', 'traf', 'mvex', 'moof', 'styp', 'sidx']);
function walkBoxes(bytes, offset, end, visit) {
  while (offset < end) {
    if (offset + 8 > end) throw new Error('mp4_header_short');
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error('mp4_header_short');
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('mp4_box_too_large');
      size = Number(large); header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) throw new Error('mp4_box_size');
    visit({ type, offset, size, header, payloadStart: offset + header, payloadEnd: offset + size });
    if (CONTAINER_BOXES.has(type)) walkBoxes(bytes, offset + header, offset + size, visit);
    offset += size;
  }
}

function readCString(bytes, start, end) {
  const stop = bytes.indexOf(0, start);
  if (stop < 0 || stop >= end) throw new Error('emsg_string_terminator');
  return { value: bytes.toString('utf8', start, stop), next: stop + 1 };
}

// 遍历 fMP4 字节并提取全部 emsg（v0/v1），不解码任何音视频 box。
// 保留各字段原 timescale、原始字节载荷与 box 定位，换算依据交给上层时间线模块。
export function eventMessages(bytes) {
  const events = [];
  walkBoxes(bytes, 0, bytes.length, box => {
    if (box.type !== 'emsg') return;
    const p = box.payloadStart;
    const end = box.payloadEnd;
    if (p + 4 > end) throw new Error('emsg_header_short');
    const version = bytes[p];
    const flags = bytes.readUIntBE(p + 1, 3);
    let cursor = p + 4;
    const u32 = () => { if (cursor + 4 > end) throw new Error('emsg_field_short');
      const value = bytes.readUInt32BE(cursor); cursor += 4; return value; };
    const u64 = () => { if (cursor + 8 > end) throw new Error('emsg_field_short');
      const value = bytes.readBigUInt64BE(cursor); cursor += 8; return value; };
    let parsed;
    if (version === 0) {
      const scheme = readCString(bytes, cursor, end); cursor = scheme.next;
      const value = readCString(bytes, cursor, end); cursor = value.next;
      const timescale = u32();
      const presentationTimeDelta = u32();
      const eventDuration = u32();
      const id = u32();
      parsed = { version, flags, schemeIdUri: scheme.value, value: value.value,
        timescale, presentationTimeDelta, eventDuration, id };
    } else if (version === 1) {
      const timescale = u32();
      const presentationTime = u64();
      const eventDuration = u32();
      const id = u32();
      const scheme = readCString(bytes, cursor, end); cursor = scheme.next;
      const value = readCString(bytes, cursor, end); cursor = value.next;
      parsed = { version, flags, timescale, presentationTime: presentationTime.toString(),
        eventDuration, id, schemeIdUri: scheme.value, value: value.value };
    } else {
      throw new Error(`emsg_version_${version}`);
    }
    const message = bytes.subarray(cursor, end);
    events.push({ boxOffset: box.offset, boxSize: box.size, ...parsed,
      messageBase64: message.toString('base64'), messageLength: message.length });
  });
  return events;
}
