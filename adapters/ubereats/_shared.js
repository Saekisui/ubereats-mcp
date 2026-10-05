// Uber Eats OpenCLI adapter 公用件（界面语言 / 价格 / 按钮文字在 _ui.js）。
// 读：页内 fetch 用户登录态下的 /_p/api/*（getSearchFeedV1 / getDraftOrdersByEaterUuidV1 / getCartsViewForEaterUuidV1 / getActiveOrdersV1）
// 写：页面真输入（quick-add-button / 模态框选项 + add-to-cart-button / place-order-btn）
// 用 scripts/sync-adapters.sh 复制到 ~/.opencli/clis/ubereats/ 给 OpenCLI 加载（OpenCLI 不认软链目录）。
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { localeOf, parseMoney, PRICE, UI } from './_ui.js';

export const UE = 'https://www.ubereats.com';
export const LOCALE = localeOf();   // { prefix: '' | '/jp', code: 'en-US' | 'jp' }

// page.evaluate 在不同版本里可能直接回值、也可能包一层 {value}
export function unwrap(raw) {
  if (raw && typeof raw === 'object' && 'value' in raw && Object.keys(raw).length <= 2 && !('status' in raw)) return raw.value;
  return raw;
}

export async function currentUrl(page) {
  try { if (page.getCurrentUrl) return (await page.getCurrentUrl()) || ''; } catch { /* ignore */ }
  try { return String(unwrap(await page.evaluate('location.href')) || ''); } catch { return ''; }
}

// 保证当前 tab 在 ubereats.com 上（页内 fetch 要同源 cookie）
export async function ensureUE(page) {
  const url = await currentUrl(page);
  if (!/ubereats\.com/.test(url)) {
    await page.goto(`${UE}${LOCALE.prefix}/feed`);
    await page.wait(3);
  }
}

// 页内调 Uber Eats 的 _p/api（用户的 session cookie 自动带上；x-csrf-token: x 是它的前端约定）
export async function api(page, name, body = {}) {
  const js = `(async () => {
    try {
      const r = await fetch('/_p/api/${name}?localeCode=${LOCALE.code}', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: ${JSON.stringify(JSON.stringify(body))} });
      const t = await r.text();
      return { status: r.status, text: t };
    } catch (e) { return { status: 0, text: String(e) }; }
  })()`;
  const res = unwrap(await page.evaluate(js)) || {};
  let j = null;
  try { j = JSON.parse(res.text); } catch { /* not json */ }
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError('www.ubereats.com', 'Uber Eats session missing/expired — log in at https://www.ubereats.com in Chrome');
  if (!j || j.status !== 'success') {
    const msg = j?.data?.message || j?.message || `HTTP ${res.status}`;
    if (/login|unauthor|auth/i.test(String(msg))) throw new AuthRequiredError('www.ubereats.com', `Uber Eats: ${msg} — log in at https://www.ubereats.com in Chrome`);
    throw new CommandExecutionError(`ubereats ${name}: ${String(msg).slice(0, 200)}`);
  }
  return j.data;
}

// bootstrap.json 读不到（页面还在跳 / 请求被打断）≠ 没登录——以前当成没登录，明明登着却报 AUTH_REQUIRED。
// 等一下再读一次，还读不到就报真实错误。
export async function isLoggedIn(page) {
  const probe = async () => unwrap(await page.evaluate(`(async () => { try { const r = await fetch('/bootstrap.json', { credentials: 'include' }); const j = await r.json(); return { ok: true, loggedIn: !!j.isLoggedIn }; } catch (e) { return { ok: false, err: String(e) }; } })()`));
  let res = await probe();
  if (!res?.ok) { await page.wait(2); res = await probe(); }
  if (!res?.ok) throw new CommandExecutionError(`读不到 Uber Eats 登录态（bootstrap.json：${res?.err || '?'}；页面 ${(await currentUrl(page)).slice(0, 100)}）——不是没登录，是页面没就绪，再试一次`);
  return !!res.loggedIn;
}

export async function requireLogin(page) {
  if (!(await isLoggedIn(page))) throw new AuthRequiredError('www.ubereats.com', 'Not logged in to Uber Eats — log in at https://www.ubereats.com in Chrome');
}

// 短 id（URL 最后一段，如 AbCdEfGhIjKlMnOpQrStUv）/ 完整路径 / 完整 URL → 店页 URL
export function storeUrl(id) {
  const s = String(id || '').trim();
  if (!s) throw new CommandExecutionError('store id required');
  if (/^https?:\/\//.test(s)) return s;
  if (s.startsWith('/')) return `${UE}${!LOCALE.prefix || s.startsWith(`${LOCALE.prefix}/`) ? '' : LOCALE.prefix}${s}`;
  return `${UE}${LOCALE.prefix}/store/s/${encodeURIComponent(s)}`;
}
export function shortIdFromUrl(url) {
  const m = String(url || '').match(/\/store\/[^/?#]+\/([^/?#]+)/);
  return m ? m[1] : null;
}

export { parseMoney };

// 购物车列表：draft orders（明细）+ carts view（店名）合并
export async function loadCarts(page) {
  const [drafts, view] = await Promise.all([api(page, 'getDraftOrdersByEaterUuidV1', {}), api(page, 'getCartsViewForEaterUuidV1', {})]);
  const titles = new Map((view?.cartsView?.carts || []).map((c) => [c.draftOrderUUID, c.title]));
  return (drafts?.draftOrders || []).map((d) => {
    const items = d.shoppingCart?.items || [];
    return {
      draft_id: d.uuid,
      store_id: d.shoppingCart?.storeInfo?.storeUUID || d.storeUuid || '',
      store: titles.get(d.uuid) || '',
      item_count: items.reduce((s, it) => s + (Number(it.quantity) || 0), 0),
      items: items.map((it) => `${it.title}×${it.quantity}`).join('；'),
      item_titles: items.map((it) => it.title),
      modified: d.shoppingCart?.lastModifiedTimestamp || d.createdAt || '',
    };
  }).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
}

// 原生点击（CDP 真输入事件）——有 nativeClick 就用坐标点，没有退回 page.click(selector)
export async function nativeClickSelector(page, selector) {
  // 同一 testid 常有桌面 / 移动两份（一份 0×0 隐藏）——挑第一个有尺寸的
  const rect = unwrap(await page.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; if (!els.length) return null; const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || els[0]; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' }; })()`));
  if (!rect) throw new CommandExecutionError(`element not found: ${selector}`);
  if (rect.disabled) throw new CommandExecutionError(`element disabled: ${selector}`);
  if (page.nativeClick && rect.w > 0 && rect.h > 0) { await page.nativeClick(Math.round(rect.x), Math.round(rect.y)); return 'native'; }
  await page.click(selector);
  return 'js';
}

// ── 按 draft 键的结算接口（2026-08-22 修复，见 PITFALLS.md「串台」：/jp/checkout 页面无视 draftOrderUUID 参数，永远渲染「活跃车」，
//    review 若抠页面 DOM 会把 A 店的品配上 B 店的钱。页面自己切车时发的请求体抓出来了——照抄）──
const CP_PAYLOADS = ['cartItems', 'subtotal', 'fareBreakdown', 'total', 'eta', 'locationInfo', 'orderConfirmations'];
const rich = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(rich).filter(Boolean).join('');
  if (v.richTextElements) return rich(v.richTextElements);
  if (v.text !== undefined) return rich(v.text);
  if (v.title !== undefined && typeof v.title !== 'object') return String(v.title);
  return '';
};
const money = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; if (v.formattedValue) return v.formattedValue; if (v.textFormat) return String(v.textFormat).replace(/<[^>]+>/g, '').trim(); if (v.text) return rich(v.text); if (v.value) return money(v.value); if (Number.isFinite(v.amountE5)) return String(v.amountE5 / 1e5); return ''; };
const decimalQty = (q) => { const c = q?.value?.coefficient || q?.coefficient; if (!c) return Number(q) || 1; const coef = (Number(c.high) || 0) * 4294967296 + (Number(c.low) || 0); const exp = q?.value?.exponent ?? q?.exponent ?? -5; const n = coef * Math.pow(10, exp); return Number.isFinite(n) && n > 0 ? n : 1; };

export async function checkoutPresentation(page, draftId) {
  const data = await api(page, 'getCheckoutPresentationV1', {
    payloadTypes: CP_PAYLOADS, draftOrderUUID: draftId, isGroupOrder: false,
    clientFeaturesData: { paymentSelectionContext: { value: JSON.stringify({ deviceContext: { thirdPartyApplications: ['google_pay'] } }) } },
    webGiftingPersonalizationEnabled: true,
  });
  const cp = data?.checkoutPayloads || {};
  const charges = [];
  for (const c of cp.fareBreakdown?.charges || []) {
    const label = rich(c.title) || c.fareBreakdownChargeMetadata?.fareInfoID || '?';
    const subs = (c.subCharges || []).map((s) => ({ label: rich(s.title), value: money(s.value) }));
    charges.push({ label, value: money(c.value), subs });
  }
  const items = (cp.cartItems?.cartItems || []).map((it) => ({
    title: rich(it.title),
    qty: decimalQty(it.quantity),
    options: (it.customizations || []).map(rich).filter(Boolean).join(' / ').slice(0, 120),
  }));
  const loc = cp.locationInfo || {};
  const addrTitle = rich(loc.address?.title);
  const addrSub = rich(loc.address?.subtitle);
  const addressMissing = !addrTitle || UI.addressMissing.test(`${addrTitle} ${addrSub}`);
  const totalText = money(cp.total?.total);
  return {
    totalText, total: parseMoney(totalText),
    subtotal: money(cp.subtotal?.subtotal),
    charges, items,
    eta: [rich(cp.eta?.rangeText), rich(cp.eta?.scheduleText)].filter(Boolean).join(' / '),
    address: addressMissing ? '' : [addrTitle, addrSub].filter(Boolean).join(' '),
    addressMissing,
    instruction: rich(loc.instruction?.title),
    confirmations: cp.orderConfirmations ? JSON.stringify(cp.orderConfirmations).slice(0, 200) : '',
  };
}

// draft 本体（店 uuid / 地址 / 支付 profile / 校验错误）——跟 getDraftOrdersByEaterUuidV1 是两条路，可以互相当锚
export async function draftByUuid(page, draftId) {
  const data = await api(page, 'getDraftOrderByUuidV2', { draftOrderUUID: draftId });
  const d = data?.draftOrder || data || {};
  const da = d.deliveryAddress || {};
  return {
    storeUuid: d.storeUuid || d.shoppingCart?.storeInfo?.storeUUID || '',
    paymentProfileUUID: d.paymentProfileUUID || '',
    validationErrors: Array.isArray(data?.validationErrors) ? data.validationErrors.map((e) => rich(e.message || e.title || e) || JSON.stringify(e).slice(0, 80)) : [],
    deliveryAddress: { title: da.address?.title || da.address?.address1 || '', lat: Number(da.latitude) || null, lng: Number(da.longitude) || null },
  };
}

// 这台 Chrome 的「当前配送位置」cookie（uev2.loc，全局一份，跟 draft 地址是两回事——见 PITFALLS.md「地址 cookie」）。只能在 ubereats.com 页面上读。
export async function readLocCookie(page) {
  const r = unwrap(await page.evaluate(`(() => { try { const m = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('uev2.loc=')); if (!m) return null; const j = JSON.parse(decodeURIComponent(m.slice(9))); return { title: j.address?.title || '', subtitle: j.address?.subtitle || '', lat: Number(j.latitude) || null, lng: Number(j.longitude) || null }; } catch (e) { return { error: String(e) }; } })()`));
  return r && !r.error ? r : null;
}
export function metersBetween(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000; const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// 支付方式标签（payments.ubereats.com；拿不到就回 uuid 前 8 位）
export async function paymentLabel(page, profileUuid) {
  if (!profileUuid) return '';
  try {
    const res = unwrap(await page.evaluate(`(async () => { try { const r = await fetch('https://payments.ubereats.com/_api/payment-profiles?key=production_u2bkf0z5pn0e552g', { credentials: 'include' }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } })()`));
    const j = JSON.parse(res.text);
    const list = j?.availablePaymentProfiles || j?.paymentProfiles || j?.data?.paymentProfiles || [];
    const p = list.find((x) => x.uuid === profileUuid);
    if (p) return `${p.tokenType || p.type || ''} ${p.accountName || p.cardNumber || p.displayName || ''}`.trim();
  } catch { /* fall through */ }
  return profileUuid.slice(0, 8) + '…';
}

// 店 uuid → 店页短 id（URL 最后一段 = uuid 16 字节的 base64url）
export function shortIdFromUuid(uuid) {
  const hex = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function uuidFromShortId(id) {
  const b = Buffer.from(String(id || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b.length !== 16) return null;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 把目标车变成「活跃车」并走到它的结算页（place 用）——2026-08-22 夜定稿的路径：
//   店页（店 uuid → 短 id）→ 头部购物车按钮（aria「N 個の商品」，店内专属，包着 view-carts-badge）→ 面板「お会計に進む」
//   （go-to-checkout-button）→ /checkout 渲染的就是这家店的车。
//   不走 feed 抽屉：那条要按店名匹配 menuitem，而且 feed 头部异步渲染很飘。
export async function openCheckoutViaStore(page, storeUuid) {
  const sid = shortIdFromUuid(storeUuid);
  if (!sid) throw new CommandExecutionError(`bad store uuid: ${storeUuid}`);
  await page.goto(`${UE}${LOCALE.prefix}/store/s/${sid}`);
  let clicked = false; let env = null;
  for (let i = 0; i < 30; i += 1) {
    await page.wait(1);
    const r = unwrap(await page.evaluate(`(() => {
      const env = { url: location.href.slice(0, 90), loaded: !!document.querySelector('[data-testid=store-loaded]'), badge: !!document.querySelector('[data-testid=view-carts-badge]') };
      const badge = document.querySelector('[data-testid=view-carts-badge]');
      const b = badge ? (badge.closest('button, [role=button], a') || badge.parentElement) : null;
      if (!b) return { ok: false, env };
      b.click(); return { ok: true, env, label: b.getAttribute('aria-label') || b.innerText.replace(/\\s+/g, ' ').slice(0, 30) };
    })()`));
    env = r?.env; if (r?.ok) { clicked = true; break; }
  }
  if (!clicked) throw new CommandExecutionError(`store page cart button not found（${JSON.stringify(env)}）——这家店在这个账号下可能没有购物车`);
  let ready = false;
  for (let i = 0; i < 12; i += 1) { await page.wait(1); ready = !!unwrap(await page.evaluate(`!!document.querySelector('[data-testid=go-to-checkout-button]')`)); if (ready) break; }
  if (!ready) throw new CommandExecutionError('cart panel (go-to-checkout-button) did not appear on store page');
  const probe = async () => unwrap(await page.evaluate(`(() => { const el = document.querySelector('[data-testid=fare-breakdown-total-label]'); return { total: !!(el && ${PRICE}.test((el.parentElement || el).innerText || '')), url: location.href.slice(0, 120), goBtn: !!document.querySelector('[data-testid=go-to-checkout-button]') }; })()`));
  const clickVia = await nativeClickSelector(page, '[data-testid=go-to-checkout-button]');
  let st = null;
  for (let i = 0; i < 25; i += 1) {
    await page.wait(1);
    st = await probe();
    if (st?.total && /\/checkout/.test(st.url)) return; // 店页面板里也有 fare-breakdown 行——必须真到了 /checkout
    if (i === 8 && st && !/\/checkout/.test(st.url) && st.goBtn) { try { await page.click('[data-testid=go-to-checkout-button]'); } catch { /* ignore */ } }
  }
  throw new CommandExecutionError(`checkout page did not render a total after store hand-off（click=${clickVia} ${JSON.stringify(st)}）`);
}

// 结算页 DOM 事实（只用来跟 API 交叉校验 + 找下单按钮，不再当价格来源）
export async function checkoutDomFacts(page) {
  let facts = null;
  for (let i = 0; i < 10; i += 1) {
    facts = await readCheckoutDom(page);
    if (facts?.totalText && /\/checkout/.test(facts.url || '')) break;
    await page.wait(1);
  }
  return facts;
}
async function readCheckoutDom(page) {
  return unwrap(await page.evaluate(`(() => {
    const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
    const totalText = t(document.querySelector('[data-testid=fare-breakdown-total-label]')?.parentElement);
    const placeBtn = document.querySelector('[data-testid=place-order-btn]');
    return {
      totalText: (totalText.match(${PRICE}) || [''])[0],
      storeHrefs: [...new Set([...document.querySelectorAll('a[href*="/store/"]')].map((a) => decodeURIComponent(a.getAttribute('href') || '')))].slice(0, 3),
      address: t(document.querySelector('[data-testid=checkout-delivery-address-section]')).replace(/編集|Edit/g, '').trim(),
      placeBtnText: t(placeBtn), placeBtnDisabled: !placeBtn || placeBtn.disabled || placeBtn.getAttribute('aria-disabled') === 'true',
      url: location.href,
    };
  })()`));
}
