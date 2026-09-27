import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { env } from '../env';
import { PARTNER_NAME } from '../../shared/shop';
import type { AppConfig } from '../../shared/types';

export const configRoutes = new Hono<AppEnv>();

configRoutes.get('/config', c => {
  const body: AppConfig = {
    mapsApiKey: env.GOOGLE_MAPS_API_KEY,
    mapId: env.GOOGLE_MAPS_MAP_ID,
    devTools: env.DEV_TOOLS,
    partnerName: PARTNER_NAME,
  };
  return c.json(body);
});
