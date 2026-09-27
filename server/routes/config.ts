import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { env, samplePhotos } from '../env';
import type { AppConfig } from '../../shared/types';

export const configRoutes = new Hono<AppEnv>();

configRoutes.get('/config', c => {
  const body: AppConfig = {
    mapsApiKey: env.GOOGLE_MAPS_API_KEY,
    mapId: env.GOOGLE_MAPS_MAP_ID,
    devTools: env.DEV_TOOLS,
    samplePhotos,
  };
  return c.json(body);
});
