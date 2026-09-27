import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth';
import { sql } from '../db';
import { imageUrl } from '../dto';
import { fail, isUuid } from '../http';

// Owner: be-core. POST /images (multipart "file"), GET /images/:id
export const imageRoutes = new Hono<AppEnv>();

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 6 * 1024 * 1024;

imageRoutes.post('/images', async c => {
  const me = requireUser(c);
  let file: unknown;
  try {
    file = (await c.req.parseBody())['file'];
  } catch {
    fail(400, 'no_file', 'Choose a photo to upload.');
  }
  if (!(file instanceof File)) fail(400, 'no_file', 'Choose a photo to upload.');
  if (!TYPES.has(file.type)) fail(415, 'bad_type', 'Use a JPG, PNG or WebP photo.');
  if (file.size > MAX_BYTES) fail(413, 'too_large', 'That photo is too large.');
  if (file.size === 0) fail(400, 'no_file', 'Choose a photo to upload.');

  const data = Buffer.from(await file.arrayBuffer());
  const [row] = await sql`
    INSERT INTO images (uploader_id, mime, bytes, data)
    VALUES (${me.id}, ${file.type}, ${data.length}, ${data})
    RETURNING id`;
  return c.json({ id: row.id as string, url: imageUrl(row.id) }, 201);
});

imageRoutes.get('/images/:id', async c => {
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'not_found', 'Photo not found.');
  const [row] = await sql`SELECT mime, data FROM images WHERE id = ${id}`;
  if (!row) fail(404, 'not_found', 'Photo not found.');
  return new Response(new Uint8Array(row.data), {
    headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
});
