import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv } from '../auth';
import { sql } from '../db';
import { fail, isUuid, parse, readJson } from '../http';
import { toVoucher } from '../dto';
import { newVoucherCode } from '../services/codes';
import { SHOP_ITEMS } from '../../shared/shop';

export const shopRoutes = new Hono<AppEnv>();

type VoucherRow = Parameters<typeof toVoucher>[0];
const PurchaseBody = z.object({ itemId: z.string({ error: 'Pick an item.' }).max(100, 'Pick an item.') });
const VOUCHER_NOT_FOUND = 'Voucher not found.';

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

shopRoutes.get('/shop/items', c => c.json(SHOP_ITEMS));

shopRoutes.post('/shop/purchase', async c => {
  const me = requireUser(c);
  const { itemId } = parse(PurchaseBody, await readJson(c));
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) fail(404, 'unknown_item', 'This item is not in the shop anymore.');

  const result = await sql.begin(async tx => {
    const [u] = await tx`UPDATE users SET coins = coins - ${item.cost}
                          WHERE id = ${me.id} AND coins >= ${item.cost} RETURNING coins`;
    if (!u) fail(409, 'not_enough_coins', 'Not enough coins yet — join a cleanup to earn more.');

    const insert = () => tx.savepoint(sp => sp<VoucherRow[]>`
      INSERT INTO vouchers (user_id, item_id, title, partner, code, cost)
      VALUES (${me.id}, ${item.id}, ${item.title}, ${item.partner}, ${newVoucherCode()}, ${item.cost})
      RETURNING *`);
    let rows: VoucherRow[];
    try {
      rows = await insert();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      rows = await insert();
    }
    const voucher = rows[0];
    await tx`INSERT INTO ledger (user_id, kind, voucher_id, coins_delta, seen_at)
             VALUES (${me.id}, 'purchase', ${voucher.id}, ${-item.cost}, now())`;
    return { voucher: toVoucher(voucher), coins: u.coins as number };
  });
  return c.json(result, 201);
});

shopRoutes.get('/vouchers', async c => {
  const me = requireUser(c);
  const rows = await sql<VoucherRow[]>`
    SELECT * FROM vouchers WHERE user_id = ${me.id} ORDER BY (status = 'active') DESC, created_at DESC`;
  return c.json(rows.map(toVoucher));
});

shopRoutes.post('/vouchers/:id/use', async c => {
  const me = requireUser(c);
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'not_found', VOUCHER_NOT_FOUND);
  const [v] = await sql<{ status: string }[]>`SELECT status FROM vouchers WHERE id = ${id} AND user_id = ${me.id}`;
  if (!v) fail(404, 'not_found', VOUCHER_NOT_FOUND);
  if (v.status === 'used') fail(409, 'already_used', 'This voucher was already used.');
  const [row] = await sql<VoucherRow[]>`
    UPDATE vouchers SET status = 'used', used_at = now()
     WHERE id = ${id} AND user_id = ${me.id} AND status = 'active' RETURNING *`;
  if (!row) fail(409, 'already_used', 'This voucher was already used.');
  return c.json(toVoucher(row));
});
