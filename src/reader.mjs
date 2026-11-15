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
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || offset + size > bytes.length) throw new Error('mp4_box_size');
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), offset, size,
      payload: bytes.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return result;
}
