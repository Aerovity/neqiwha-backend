import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth';
import { sql } from '../db';
import { env } from '../env';
import { fail, isUuid, readJson } from '../http';
import { FAIL_OPEN_ANALYSIS, analyzePhoto } from '../services/gemini';
import type { PhotoAnalysis } from '../../shared/types';

// Owner: be-core. POST /ai/analyze-photo
export const aiRoutes = new Hono<AppEnv>();

aiRoutes.post('/ai/analyze-photo', async c => {
  const me = requireUser(c);
  const { imageId } = await readJson(c);
  if (typeof imageId !== 'string' || !isUuid(imageId)) fail(404, 'image_not_found', 'Upload the photo first.');
  const [img] = await sql`SELECT mime, data FROM images WHERE id = ${imageId} AND uploader_id = ${me.id}`;
  if (!img) fail(404, 'image_not_found', 'Upload the photo first.');
  let analysis: PhotoAnalysis;
  try {
    analysis = await analyzePhoto({ buf: Buffer.from(img.data), mime: img.mime });
  } catch (err) {
    console.error('analyze-photo: AI failed:', err instanceof Error ? err.message : err);
    if (!env.AI_FAIL_OPEN) fail(503, 'ai_unavailable', "The AI couldn't check this photo. Try again in a moment.");
    analysis = FAIL_OPEN_ANALYSIS;
  }
  // POST /events only trusts this stored copy, never an analysis sent by the client.
  await sql`UPDATE images SET ai_analysis = ${sql.json(analysis as unknown as Parameters<typeof sql.json>[0])} WHERE id = ${imageId}`;
  return c.json(analysis);
});
