import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { UE, LOCALE, requireLogin, loadCarts, checkoutPresentation, draftByUuid, paymentLabel } from './_shared.js';

// 结算快照（唯一可信价）——2026-08-22 修复「串台」（见 PITFALLS.md）：
//   旧版抠 /checkout 页面 DOM，而那页无视 draftOrderUUID 参数、永远渲染「活跃车」→ A 店的品配 B 店的钱。
//   新版不碰页面：费用 / 合计 / 商品 / 地址 / ETA 全部来自按 draft 键的 getCheckoutPresentationV1（页面切车时自己发的同一个接口）。
// 防串台硬校验：两条独立路子互相当锚——
//   ① getDraftOrderByUuidV2 的 storeUuid 必须 == 购物车列表（getDraftOrdersByEaterUuidV1）里该 draft 的 store_id
//   ② 接口回的商品标题集合必须覆盖购物车列表里该 draft 的商品标题
//   任一不符 → throw，绝不返回混血快照。
const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 12);

export async function reviewSnapshot(page, cart) {
  const [cp, d] = await Promise.all([checkoutPresentation(page, cart.draft_id), draftByUuid(page, cart.draft_id)]);
  if (d.storeUuid && cart.store_id && d.storeUuid !== cart.store_id) {
    throw new CommandExecutionError(`串台：draft ${cart.draft_id} 的店 uuid 不一致（cart 列表 ${cart.store_id} vs draft 本体 ${d.storeUuid}）——不出快照`);
  }
  const apiTitles = cp.items.map((it) => norm(it.title));
  const missing = (cart.item_titles || []).filter((t) => t && !apiTitles.some((a) => a.includes(norm(t)) || norm(t).includes(a)));
  if (missing.length) {
    throw new CommandExecutionError(`串台：结算接口回的商品里找不到购物车里的「${missing.join('」「')}」（接口：${cp.items.map((i) => i.title).join('；') || '空'}）——不出快照`);
  }
  if (!cp.total) throw new CommandExecutionError(`结算接口没回合计（draft ${cart.draft_id}）——不出快照`);
  const payment = await paymentLabel(page, d.paymentProfileUUID);
  return { cp, d, payment };
}

export function snapshotRows(cart, { cp, d, payment }) {
  const rows = [
    { field: 'draft_id', value: cart.draft_id },
    { field: 'store', value: cart.store },
    { field: 'items', value: cp.items.map((it) => `${it.title}×${it.qty}${it.options ? `（${it.options}）` : ''}`).join('；') || cart.items },
  ];
  for (const c of cp.charges) {
    if (c.subs.length && !c.value) for (const s of c.subs) rows.push({ field: s.label || c.label, value: s.value });
    else rows.push({ field: c.label, value: c.value });
  }
  rows.push(
    { field: 'total', value: String(cp.total ?? '') },
    { field: 'total_text', value: cp.totalText },
    { field: 'eta', value: cp.eta },
    { field: 'address', value: cp.addressMissing ? '（这辆车没设配送地址——下单前先在 app 里给它选地址）' : cp.address },
    { field: 'instruction', value: cp.instruction },
    { field: 'payment', value: payment },
  );
  if (d.validationErrors.length) rows.push({ field: 'warnings', value: d.validationErrors.join('；') });
  if (cp.confirmations) rows.push({ field: 'confirmations', value: cp.confirmations });
  rows.push({ field: 'source', value: 'getCheckoutPresentationV1（按 draft 键，不是页面 DOM）' });
  return rows;
}

cli({
  site: 'ubereats',
  name: 'review',
  access: 'read',
  description: 'Uber Eats 结算快照（按 draft 键的接口，不是页面）：店 / 品 / 各项费用 / 合计 / ETA / 地址 / 支付；串台校验不过直接报错',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'draft', help: 'draft_id（cart 给的）；缺省 = 最近改动的那个购物车' },
  ],
  columns: ['field', 'value'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    await page.goto(`${UE}${LOCALE.prefix}/feed`);
    await page.wait(3);
    await requireLogin(page);
    const carts = await loadCarts(page);
    const cart = kwargs.draft ? carts.find((c) => c.draft_id === String(kwargs.draft)) : carts[0];
    if (!cart) throw new CommandExecutionError(kwargs.draft ? `draft ${kwargs.draft} not found in carts` : 'no cart to review');
    const snap = await reviewSnapshot(page, cart);
    return snapshotRows(cart, snap);
  },
});
