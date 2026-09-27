import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import type { AppEnv } from '../auth';
import { samplePhotos } from '../env';
import { fail } from '../http';
import { SAMPLE_PHOTOS, type SamplePhoto } from '../../shared/types';

// Owner: be-core. GET /dev/sample/:name (DEV_TOOLS or DEMO_SAMPLES)
export const devRoutes = new Hono<AppEnv>();

const isSample = (name: string): name is SamplePhoto => (SAMPLE_PHOTOS as readonly string[]).includes(name);

devRoutes.get('/dev/sample/:name', async c => {
  const name = c.req.param('name');
  if (!samplePhotos || !isSample(name)) fail(404, 'not_found', 'Unknown API route');
  const data = await readFile(new URL(`../../test-assets/${name}.png`, import.meta.url));
  return new Response(new Uint8Array(data), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  });
});
