import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { isProd, listenPort } from './env';
import { initSchema } from './db';
import { api } from './routes';

await initSchema();

const app = new Hono();
if (!isProd) {
  app.use('*', async (c, next) => {
    const t = Date.now();
    await next();
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t}ms`);
  });
}
app.route('/api', api);
app.all('*', c => c.json({ error: { code: 'not_found', message: 'Unknown API route' } }, 404));

// "::" accepts IPv4 and IPv6, which Railway private networking needs.
serve({ fetch: app.fetch, port: listenPort, hostname: '::' },
  info => console.log(`Naqiwha API listening on :${info.port}`));
