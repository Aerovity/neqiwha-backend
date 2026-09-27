import { randomInt, createHmac } from 'node:crypto';
import { env } from '../env';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export const randomCode = (len: number) =>
  Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
export const newQrCode = () => randomCode(8);
export const newVoucherCode = () => `HBK-${randomCode(6)}`;
export const newOtp = () => randomInt(0, 1_000_000).toString().padStart(6, '0');
export const hashOtp = (email: string, code: string) =>
  createHmac('sha256', env.SESSION_SECRET).update(`${email}:${code}`).digest('hex');
/** Accepts "naqiwha:7F3K9Q2M", "7f3k-9q2m", " 7F3K 9Q2M " … */
export const normalizeQr = (raw: string) =>
  raw.trim().toUpperCase().replace(/^NAQIWHA:/, '').replace(/[^A-Z0-9]/g, '');
