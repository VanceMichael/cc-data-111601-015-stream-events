export async function acquire(base, path, headers = {}) {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin) throw new Error('outside_source');  const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok && response.status !== 304) throw new Error(`source_status_${response.status}`);
  const responseHeaders = Object.fromEntries(response.headers);
  if (response.status === 304) {
    return { bytes: null, headers: responseHeaders, status: 304, etag: responseHeaders.etag ?? null };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('source_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), headers: responseHeaders, status: response.status,
    etag: responseHeaders.etag ?? null };
}
