import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadUser, type AppEnv } from '../auth';
import { ApiError } from '../http';
import { healthRoutes } from './health';
import { configRoutes } from './config';
import { authRoutes } from './auth';
import { meRoutes } from './me';
import { imageRoutes } from './images';
import { aiRoutes } from './ai';
import { eventRoutes } from './events';
import { leaderboardRoutes } from './leaderboard';
import { shopRoutes } from './shop';
import { devRoutes } from './dev';
import { adminRoutes } from './admin';
import { chatRoutes } from './chat';

export const api = new Hono<AppEnv>();
api.use('*', bodyLimit({
  maxSize: 8 * 1024 * 1024,
  onError: c => c.json({ error: { code: 'too_large', message: 'That photo is too large.' } }, 413),
}));
api.use('*', loadUser);
api.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } }, 500);
});

// Every router declares its own full paths (e.g. '/auth/request-code'), so all mount at '/'.
api.route('/', healthRoutes);
api.route('/', configRoutes);
api.route('/', authRoutes);
api.route('/', meRoutes);
api.route('/', imageRoutes);
api.route('/', aiRoutes);
api.route('/', eventRoutes);
api.route('/', chatRoutes);
api.route('/', leaderboardRoutes);
api.route('/', shopRoutes);
api.route('/', devRoutes);
api.route('/', adminRoutes);
