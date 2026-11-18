import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { createHarbor } from './harbor.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { startProvider } from './provider.mjs';

export async function startService({ source, directory, port = 0, harborPath = process.env.HARBOR_PATH ?? null,
  pollMs = Number(process.env.HARBOR_POLL_MS ?? 0) }) {
  const store = await new Store(directory).initialize();
  const harbor = await createHarbor({ source, directory: join(directory, 'harbor') });
  const harborStore = harbor.store;
  let timer = null;
  const readBody = async request => {
    const chunks = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16384) throw new Error('request_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = JSON.parse((await readBody(request)).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/harbor/intakes' && request.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(request)).toString()); }
        catch { throw new Error('invalid_json'); }
        if (payload === null || typeof payload !== 'object' || typeof payload.path !== 'string'
          || payload.path.length === 0) throw new Error('path_required');
        let summary;
        try {
          summary = await harbor.cycle(payload.path);
        } catch (error) {
          throw new Error(error.message); // 跨源/领取失败统一走 422，不留半成品
        }
        if (summary.error) { response.statusCode = 422; return response.end(JSON.stringify(summary)); }
        response.statusCode = 201;
        return response.end(JSON.stringify(summary));
      }
      if (url.pathname === '/harbor/state' && request.method === 'GET') {
        return response.end(JSON.stringify(await harborStore.snapshot()));
      }
      if (url.pathname === '/harbor/events' && request.method === 'GET') {
        const state = await harborStore.snapshot();
        return response.end(JSON.stringify(state.events));
      }
      if (url.pathname === '/harbor/coverage' && request.method === 'GET') {
        const state = await harborStore.snapshot();
        return response.end(JSON.stringify(state.coverage));
      }
      if (url.pathname === '/harbor/observations' && request.method === 'GET') {
        const state = await harborStore.snapshot();
        return response.end(JSON.stringify(state.observations));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  if (harborPath && pollMs > 0) {
    // minimumUpdatePeriod 只是可请求建议；轮询间隔由运维显式给出，失败不退出循环。
    timer = setInterval(() => { harbor.cycle(harborPath).catch(() => {}); }, pollMs);
    timer.unref?.();
  }
  return { server, store, harbor, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { if (timer) clearInterval(timer); server.close(resolve); }) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
