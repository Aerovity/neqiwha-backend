import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().optional(),
  API_PORT: z.coerce.number().optional(),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(3),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_FALLBACK_MODELS: z.string().default('gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-flash-latest'),
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_MAPS_MAP_ID: z.string().default('DEMO_MAP_ID'),
  DEV_TOOLS: z.string().default('false').transform(v => v === 'true'),
  AI_FAIL_OPEN: z.string().default('false').transform(v => v === 'true'),
  BUILD_SHA: z.string().optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
});

export const env = Env.parse(process.env);
export const isProd = env.NODE_ENV === 'production';
export const listenPort = isProd ? (env.PORT ?? 8080) : (env.API_PORT ?? 8787);
export const buildSha = env.BUILD_SHA ?? env.RAILWAY_GIT_COMMIT_SHA ?? 'local';
