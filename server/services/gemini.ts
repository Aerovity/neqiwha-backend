import { GoogleGenAI, ThinkingLevel, type Part } from '@google/genai';
import { z } from 'zod';
import { env } from '../env';
import type { AiVerdict, PhotoAnalysis } from '../../shared/types';

// Owner: be-core. Signatures are the contract; be-game imports verifyCleanup.
export type ImageInput = { buf: Buffer; mime: string };

export const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const TIMEOUT_MS = 25_000;
const image = ({ buf, mime }: ImageInput): Part => ({ inlineData: { data: buf.toString('base64'), mimeType: mime } });
const text = (t: string): Part => ({ text: t });
const clampInt = (min: number, max: number) => z.number().transform(n => Math.min(max, Math.max(min, Math.round(n))));

// Quotas (429) and overload (503) are per model, so on failure we move down the chain instead of retrying the same model.
const MODEL_CHAIN = [env.GEMINI_MODEL, ...env.GEMINI_FALLBACK_MODELS.split(',').map(s => s.trim()).filter(Boolean)]
  .filter((m, i, all) => all.indexOf(m) === i);

// gemini-3.x flash models take no temperature/top_p/top_k, and reject thinking level "minimal".
async function askJson<T>(system: string, parts: Part[], schema: object, validate: z.ZodType<T>): Promise<T> {
  let lastError: unknown;
  for (const [i, model] of MODEL_CHAIN.entries()) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          httpOptions: { timeout: TIMEOUT_MS },
        },
      });
      if (!res.text) throw new Error('Gemini returned an empty response');
      return validate.parse(JSON.parse(res.text));
    } catch (err) {
      lastError = err;
      console.warn(`gemini: ${model} failed (${err instanceof Error ? err.message.slice(0, 120) : err})`);
      if (i < MODEL_CHAIN.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  }
  throw lastError;
}

/** Cheap connectivity check used by check-env. */
export async function pingGemini(): Promise<string> {
  const res = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: 'Reply with the single word OK',
    config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, httpOptions: { timeout: TIMEOUT_MS } },
  });
  return res.text ?? '';
}

const ANALYZE_SYSTEM =
  'You are the strict photo gatekeeper of Naqiwha, a community cleanup game in Algeria where players earn XP and ' +
  'coins for cleaning public places. Players try to cheat by uploading random photos, so you decide on your own ' +
  'whether a photo may become a cleanup spot. ACCEPT only a genuine camera photo of a real place (street, beach, ' +
  'park, stairs, empty lot, roadside, public building surroundings) with clearly visible litter or dumped waste ' +
  'that volunteers could pick up. REJECT everything else, including: indoor objects or rooms (laptops, phones, ' +
  'screens, desks, tables, furniture, kitchens, beds); a single tidy object or product; food or a meal; people, ' +
  'selfies, pets or animals as the subject; screenshots, photos of a screen, drawings, memes or stock-looking ' +
  'images; black, blank, heavily blurred or unreadable images; places that are already clean or only have one ' +
  'or two tiny pieces of litter. Never judge which country or city the place is in: a littered place anywhere is ' +
  'fine. When in doubt, REJECT. Never be polite at the expense of accuracy. ' +
  "Never invent place names that aren't visible in the photo.";

const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: "what the photo mainly shows, 3–8 words, e.g. 'a laptop on a wooden desk'" },
    accepted: { type: 'boolean', description: 'true ONLY if this is a genuine photo of a real place with visible litter or dumped waste' },
    rejection_reason: {
      type: 'string',
      description: "if not accepted: one short plain-English sentence for the player, max 120 characters, e.g. 'This shows a laptop on a desk, not a littered place.' Empty string if accepted.",
    },
    is_dirty: { type: 'boolean', description: 'true if the photo shows litter or waste that a group of volunteers could clean' },
    dirt_level: { type: 'integer', minimum: 1, maximum: 5, description: '1 = barely any litter, 5 = heavily littered or a dump' },
    items: {
      type: 'array', items: { type: 'string' }, maxItems: 5,
      description: "main kinds of waste, short lowercase English nouns, e.g. 'plastic bottles'; empty if not accepted",
    },
    suggested_title: { type: 'string', description: "short event title, max 48 characters, e.g. 'Plastic bottles by the beach stairs'; empty if not accepted" },
    suggested_description: {
      type: 'string',
      description: '1–2 friendly sentences, max 220 characters: what needs cleaning and what to bring (bags, gloves); empty if not accepted',
    },
  },
  required: ['subject', 'accepted', 'rejection_reason', 'is_dirty', 'dirt_level', 'items', 'suggested_title', 'suggested_description'],
};

const AnalyzeOut = z.object({
  subject: z.string(),
  accepted: z.boolean(),
  rejection_reason: z.string(),
  is_dirty: z.boolean(),
  dirt_level: clampInt(1, 5),
  items: z.array(z.string()),
  suggested_title: z.string(),
  suggested_description: z.string(),
});

const DEFAULT_REJECTION = "This doesn't look like a littered place. Take a photo of the mess itself.";

export async function analyzePhoto(photo: ImageInput): Promise<PhotoAnalysis> {
  const r = await askJson(ANALYZE_SYSTEM, [
    text('Decide whether this photo can become a cleanup spot. Respond with JSON only.'),
    image(photo),
  ], ANALYZE_SCHEMA, AnalyzeOut);
  // Safety net: the model's own dirt signals must agree with its acceptance.
  const accepted = r.accepted && r.is_dirty && r.dirt_level >= 2;
  return {
    isDirty: r.is_dirty,
    dirtLevel: r.dirt_level as PhotoAnalysis['dirtLevel'],
    items: accepted ? r.items.map(s => s.trim()).filter(Boolean).slice(0, 5) : [],
    suggestedTitle: accepted ? r.suggested_title.trim().slice(0, 60) : '',
    suggestedDescription: accepted ? r.suggested_description.trim().slice(0, 400) : '',
    accepted,
    rejectReason: accepted ? null : (r.rejection_reason.trim().slice(0, 160) || DEFAULT_REJECTION),
  };
}

/** Stand-in used when the AI is down and AI_FAIL_OPEN=true. */
export const FAIL_OPEN_ANALYSIS: PhotoAnalysis = {
  isDirty: true, dirtLevel: 3, items: [], suggestedTitle: '', suggestedDescription: '', accepted: true, rejectReason: null,
};

const VERIFY_SYSTEM =
  'You are the fair referee of Naqiwha, a community cleanup game in Algeria. You compare a BEFORE photo (taken when ' +
  'the spot was reported) with an AFTER photo (taken by the organizer at the end of the cleanup) and decide whether ' +
  'the spot was cleaned. Players earn rewards, so some try to cheat: judge on your own and do not give the benefit ' +
  'of the doubt. The goal is a clear, visible reduction of litter at the SAME place, not perfection: a different ' +
  'angle, zoom, lighting, time of day, weather, people in the frame and small leftovers are fine. Answer ' +
  'not_cleaned if (a) significant litter from the BEFORE photo is still clearly visible, (b) you cannot recognise ' +
  'the same place in both photos (matching ground, walls, railings, vegetation or landmarks), (c) the AFTER photo ' +
  'is not a genuine photo of that place (a screenshot, a photo of a screen, an unrelated object or room, a black ' +
  'or completely blurred image), or (d) the AFTER photo is framed so tightly that the cleaned area cannot be judged.';

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['cleaned', 'not_cleaned'] },
    same_place: { type: 'boolean', description: 'true if both photos plausibly show the same place' },
    before_litter_score: { type: 'integer', minimum: 0, maximum: 10, description: '0 = no litter, 10 = covered in litter' },
    after_litter_score: { type: 'integer', minimum: 0, maximum: 10 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: {
      type: 'string',
      description: 'one upbeat sentence for the volunteers, max 140 characters; if not cleaned, kindly say what is left',
    },
    remaining_issues: {
      type: 'array', items: { type: 'string' }, maxItems: 3,
      description: 'short phrases for litter still visible; empty if cleaned',
    },
  },
  required: ['verdict', 'same_place', 'before_litter_score', 'after_litter_score', 'confidence', 'summary', 'remaining_issues'],
};

const VerifyOut = z.object({
  verdict: z.enum(['cleaned', 'not_cleaned']),
  same_place: z.boolean(),
  before_litter_score: clampInt(0, 10),
  after_litter_score: clampInt(0, 10),
  confidence: z.number().transform(n => Math.min(1, Math.max(0, n))),
  summary: z.string(),
  remaining_issues: z.array(z.string()),
});

/** Throws on AI failure (after its own retry). Callers decide about AI_FAIL_OPEN. */
export async function verifyCleanup(before: ImageInput, after: ImageInput): Promise<AiVerdict> {
  const r = await askJson(VERIFY_SYSTEM, [
    text('BEFORE photo:'), image(before),
    text('AFTER photo:'), image(after),
    text('Judge this cleanup. Respond with JSON only.'),
  ], VERIFY_SCHEMA, VerifyOut);
  return {
    // Different places can never count as a cleanup, whatever the model's verdict says.
    verdict: r.same_place ? r.verdict : 'not_cleaned',
    samePlace: r.same_place,
    beforeScore: r.before_litter_score,
    afterScore: r.after_litter_score,
    confidence: r.confidence,
    summary: r.summary.trim().slice(0, 200),
    remainingIssues: r.remaining_issues.map(s => s.trim()).filter(Boolean).slice(0, 3),
  };
}
