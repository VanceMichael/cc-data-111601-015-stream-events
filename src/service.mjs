import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { Harvester, coverage } from './harvest.mjs';

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const harvester = new Harvester({ source, store, state: await store.loadHarvest() ?? undefined });
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
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16384) throw new Error('request_too_large');
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/harvests' && request.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16384) throw new Error('request_too_large');
          chunks.push(chunk);
        }
        const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        if (payload.path != null && typeof payload.path !== 'string') throw new Error('path_required');
        const target = new URL(payload.path ?? '/live', source);
        if (target.origin !== new URL(source).origin) throw new Error('outside_source');
        const summary = await harvester.harvest({ path: payload.path ?? '/live' });
        response.statusCode = 201;
        return response.end(JSON.stringify(summary));
      }
      if (url.pathname === '/harvests' && request.method === 'GET') {
        return response.end(JSON.stringify(harvester.state.cycles));
      }
      if (url.pathname === '/events' && request.method === 'GET') {
        let events = harvester.state.events;
        const periodId = url.searchParams.get('periodId');
        const scheme = url.searchParams.get('scheme');
        const layer = url.searchParams.get('layer');
        if (periodId) events = events.filter(event => event.periodId === periodId);
        if (scheme) events = events.filter(event => event.scheme === scheme);
        if (layer) events = events.filter(event => event.layer === layer);
        return response.end(JSON.stringify(events));
      }
      if (url.pathname === '/coverage' && request.method === 'GET') {
        return response.end(JSON.stringify(coverage(harvester.state)));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, harvester, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
