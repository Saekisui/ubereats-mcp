import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { UE, unwrap, requireLogin, api, loadCarts, currentUrl, nativeClickSelector, openCheckoutViaStore, checkoutDomFacts, parseMoney, readLocCookie, metersBetween } from './_shared.js';
import { PRICE, UI } from './_ui.js';
import { reviewSnapshot } from './review.js';

// 真下单（写·重）。只被 MCP 的 ue_place 调：那边已验 confirm_token + 上限 + 接口快照再读一次。
// 2026-08-22 夜修复：/jp/checkout?draftOrderUUID=… 无视参数、渲染「活跃车」，所以下单前必须**先经抽屉把目标车变成活跃车**
// （目标店的店页 → 头部购物车按钮 → 面板「お会計に進む」→ 结算页），再用按 draft 键的接口合计**交叉校验页面合计**，
// 对不上就拒。然后原生点 place-order-btn → 若弹最终确认框 → 原生点确认 → 等活动订单出现。
// ⚠️ 第一次真跑请人在旁边看着。
cli({
  site: 'ubereats',
  name: 'place',
  access: 'write',
  description: 'Uber Eats 下单：店页切到目标车 → 结算页合计 vs 接口合计交叉校验 → place-order-btn → 最终确认。只在 ue_review 后、用户确认后、经 MCP 硬门调用',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'draft', required: true, help: 'draft_id（必须跟 review 的同一个）' },
    { name: 'dry-run', type: 'bool', default: false, help: '走到结算页并做完交叉校验、不点下单' },
    // opencli 默认给 adapter 60 秒（OPENCLI_BROWSER_COMMAND_TIMEOUT），正常一单光固定等待就 30–45 秒；
    // 超在「已按最终确认、正在轮询订单」那段 = 单下成了却报超时。声明 timeout 参数 opencli 才认（+30 秒缓冲）
    { name: 'timeout', type: 'int', default: 150, help: '整条下单流程的超时秒数' },
  ],
  columns: ['status', 'draft_id', 'total', 'order_url', 'detail'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    const draftId = String(kwargs.draft || '');
    if (!draftId) throw new CommandExecutionError('--draft required');
    await page.goto(`${UE}/jp/feed`);
    await page.wait(2);
    await requireLogin(page);
    const carts = await loadCarts(page);
    const cart = carts.find((c) => c.draft_id === draftId);
    if (!cart) throw new CommandExecutionError(`draft ${draftId} not found in carts`);
    // 接口快照（带串台校验）= 基准
    const { cp, d: draft } = await reviewSnapshot(page, cart);
    if (cp.addressMissing) throw new CommandExecutionError(`这辆车（${cart.store}）没设配送地址——先在 app 里给它选地址，不下单`);
    // 预检（见 PITFALLS.md「地址 cookie」）：这台 Chrome 的「当前配送位置」cookie（uev2.loc）≠ 车地址 → Uber 在最终确认前弹「住所情報 / ピンの位置を調整」要人确认楼栋和针位，
    // 那个框里能点的全是 保存 / 編集 / 削除 = 写用户的地址簿，一律不点。所以不一致就在这里停，请用户在 Chrome 里把位置切到车地址再来。
    const loc = await readLocCookie(page);
    const dist = metersBetween(loc, draft.deliveryAddress);
    const locTitle = (loc?.title || '').replace(/\s+/g, '');
    const draftTitle = (draft.deliveryAddress?.title || cp.address || '').replace(/\s+/g, '');
    const sameTitle = locTitle && draftTitle && (locTitle.includes(draftTitle.slice(0, 6)) || draftTitle.includes(locTitle.slice(0, 6)));
    if (loc && !sameTitle && (dist == null || dist > 150)) {
      throw new CommandExecutionError(`这台 Chrome 的当前配送位置「${loc.title || '?'}」≠ 这辆车的地址「${draft.deliveryAddress?.title || cp.address}」（相距 ${dist ?? '?'} m）——Uber 会弹楼栋/针位确认框，脚本不碰地址簿。在 Chrome 里把配送位置切到车地址再来`);
    }
    // 店页 → 这家店的车 → 结算页
    if (!cart.store_id) throw new CommandExecutionError('cart has no store uuid');
    await openCheckoutViaStore(page, cart.store_id);
    const dlgJs = `(() => {
      const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
      const dlg = document.querySelector('[role=dialog]');
      const pageBtn = document.querySelector('[data-testid=place-order-btn]');
      if (!dlg) return { dialog: false, pageBtnText: t(pageBtn), url: location.href };
      const btns = [...dlg.querySelectorAll('button, [role=button]')].map((b, i) => ({ i, text: t(b).slice(0, 40), tid: b.dataset.testid || null, aria: b.getAttribute('aria-label') || null }));
      const head = t(dlg).slice(0, 80);
      const isUpsell = ${UI.upsellHead}.test(head) || btns.filter((b) => b.tid === 'quick-add-button').length >= 2;
      const skip = btns.find((b) => ${UI.skip}.test(b.text));
      const close = btns.find((b) => b.tid === 'close-button' || ${UI.closeAria}.test(b.aria || ''));
      const confirm = btns.find((b) => ${UI.placeFinal}.test(b.text) && !${UI.placeStep1}.test(b.text) && !${PRICE}.test(b.text));
      // 地址确认框：点下单键后 Uber 先让确认配送地址。只认 aria 里带着接口地址开头的那个地址项（= 已选地址），别的不碰
      const isAddress = ${UI.addressHead}.test(head);
      const addrKey = ${JSON.stringify((cp.address || '').slice(0, 6))};
      const addr = isAddress && addrKey ? btns.find((b) => (b.aria || '').includes(addrKey) && !${UI.editAria}.test(b.aria || '')) : null;
      // 给认出的三个目标打标记（先清旧标记），外面按标记点，不按索引——索引/nth-of-type 对不上就会点到商品按钮
      const els = [...dlg.querySelectorAll('button, [role=button]')];
      for (const e of els) e.removeAttribute('data-ue-target');
      if (skip) els[skip.i].setAttribute('data-ue-target', 'skip');
      if (close) els[close.i].setAttribute('data-ue-target', 'close');
      if (confirm) els[confirm.i].setAttribute('data-ue-target', 'confirm');
      if (addr) els[addr.i].setAttribute('data-ue-target', 'addr');
      return { dialog: true, head, isUpsell, isAddress, addr: addr || null, skip: skip || null, close: close || null, confirm: confirm || null, buttons: btns.filter((b) => !${PRICE}.test(b.text) && b.tid !== 'quick-add-button'), nItemButtons: btns.filter((b) => ${PRICE}.test(b.text) || b.tid === 'quick-add-button').length, pageBtnText: t(pageBtn), url: location.href };
    })()`;
    const clickDialogButton = async (kind) => nativeClickSelector(page, `[role=dialog] [data-ue-target="${kind}"]`);
    const trail = [loc ? `loc-cookie「${loc.title}」${dist != null ? ` ${dist}m` : ''} ✓` : 'loc-cookie 读不到'];
    // 到站即弹的 upsell 凑单框（URL 带 mod=magicUpsell）：不处理的话下面的原生点击会全部打在遮罩上。
    // 只点「スキップ」（退而点 X）；绝不碰里面任何 ￥ 商品 / quick-add；认不出的框直接停。
    {
      const d0 = unwrap(await page.evaluate(dlgJs));
      if (d0?.dialog && d0.isUpsell) {
        const kind = d0.skip ? 'skip' : d0.close ? 'close' : null;
        if (!kind) throw new CommandExecutionError(`到站 upsell 弹窗里找不到「スキップ」也找不到关闭键，不盲点。按钮：${JSON.stringify(d0.buttons)}`);
        const via = await clickDialogButton(kind);
        trail.push(`arrival-upsell=「${d0.head.slice(0, 20)}」 ${kind}=${via}（商品按钮 ${d0.nItemButtons} 个未碰）`);
        await page.wait(3);
      } else if (d0?.dialog && UI.closedHead.test(d0.head)) {
        throw new CommandExecutionError(`店铺打烊：Uber 要求预约配送时间（「${d0.head.slice(0, 40)}…」）——脚本不替人预约，换店或等开门`);
      } else if (d0?.dialog && UI.unavailableHead.test(d0.head)) {
        throw new CommandExecutionError(`店家现在不接单（「${d0.head.slice(0, 40)}…」）——没下单，换店或晚点再来`);
      } else if (d0?.dialog) {
        throw new CommandExecutionError(`到结算页就弹了认不出的框，停住：「${d0.head}」 按钮=${JSON.stringify(d0.buttons)}`);
      }
    }
    const dom = await checkoutDomFacts(page);
    const domTotal = parseMoney(dom.totalText);
    if (domTotal == null || !(Math.abs(domTotal - cp.total) < 0.005)) {
      throw new CommandExecutionError(`结算页合计（${dom.totalText || '读不到'}）≠ 接口合计（${cp.totalText}）——页面上不是这辆车，不下单`);
    }
    if (cp.address && dom.address && !dom.address.includes(cp.address.slice(0, 6))) {
      throw new CommandExecutionError(`结算页地址「${dom.address.slice(0, 20)}…」与接口地址「${cp.address.slice(0, 20)}…」对不上——不下单`);
    }
    if (dom.placeBtnDisabled) throw new CommandExecutionError(`place button disabled on checkout page（${dom.placeBtnText || 'missing'}）— address / payment / delivery option may be incomplete`);
    trail.push(`页面合计 ${dom.totalText} == 接口合计 ${cp.totalText} ✓`);
    // ★ dry-run 到此为止：不点下单键（2026-08-22 22:45 这行曾在重排时丢过一次，害 dry-run 真点了一下——别再动它）
    if (kwargs['dry-run']) return [{ status: 'dry-run', draft_id: draftId, total: cp.totalText, order_url: '', detail: `${trail.join(' → ')}；would click「${dom.placeBtnText}」` }];

    const activeBefore = (await api(page, 'getActiveOrdersV1', {}))?.orders?.length || 0;
    const via1 = await nativeClickSelector(page, '[data-testid=place-order-btn]');
    await page.wait(4);
    // ── 第一步点完可能弹东西。只认两种：(a) upsell 凑单弹窗（标题「注文の品をすべて揃える」+ 一堆 quick-add）→ 只点「スキップ」
    //    （找不到退而点 close-button 的 X），绝不碰弹窗里任何带 ￥ 的商品按钮 / quick-add；(b) 最终确认框（按钮文案 注文を確定 / 注文する）。
    //    认不出的弹窗 → 直接 throw 并把按钮全 dump 出来，宁可停也不盲点。
    trail.push(`click1=${via1}`);
    let d = unwrap(await page.evaluate(dlgJs));
    // baseui 先挂空壳、内容后到（8/22 22:00 实测：head=''、只有 baseui-modal-close）。等它渲染完再判断，别当「认不出的框」停掉。
    for (let i = 0; i < 4 && d?.dialog && !d.head && !d.confirm; i++) { await page.wait(3); d = unwrap(await page.evaluate(dlgJs)); trail.push(`empty-shell-wait${i + 1}`); }
    if (d?.dialog && d.isUpsell) {
      const kind = d.skip ? 'skip' : d.close ? 'close' : null;
      if (!kind) throw new CommandExecutionError(`upsell 弹窗里找不到「スキップ」也找不到关闭键，不盲点。弹窗按钮：${JSON.stringify(d.buttons)}`);
      const via = await clickDialogButton(kind);
      trail.push(`upsell=「${d.head.slice(0, 20)}」 ${d.skip ? 'skip' : 'close'}=${via}（商品按钮 ${d.nItemButtons} 个未碰）`);
      await page.wait(4);
      d = unwrap(await page.evaluate(dlgJs));
    }
    if (d?.dialog && UI.closedHead.test(d.head)) {
      throw new CommandExecutionError(`店铺打烊：Uber 要求预约配送时间（「${d.head.slice(0, 40)}…」）——脚本不替人预约`);
    }
    if (d?.dialog && UI.pinHead.test(d.head)) {
      throw new CommandExecutionError(`Uber 要确认楼栋/针位（「${d.head.slice(0, 30)}…」）：当前位置 cookie 与车地址不一致。框里的 保存/編集/削除 都写地址簿，脚本不碰——在 Chrome 里切好位置后重新 review → place。按钮=${JSON.stringify(d.buttons)}`);
    }
    if (d?.dialog && d.isAddress) {
      if (!d.addr) throw new CommandExecutionError(`地址确认框里找不到跟接口地址对得上的那一项（接口：「${(cp.address || '').slice(0, 20)}」），不盲点。按钮=${JSON.stringify(d.buttons)}`);
      const via = await clickDialogButton('addr');
      trail.push(`address-confirm=「${(d.addr.aria || '').slice(0, 24)}」 click=${via}`);
      await page.wait(4);
      d = unwrap(await page.evaluate(dlgJs));
      if (d?.dialog && d.isUpsell) { const kind = d.skip ? 'skip' : d.close ? 'close' : null; if (!kind) throw new CommandExecutionError(`upsell 弹窗里找不到「スキップ」也找不到关闭键，不盲点。按钮：${JSON.stringify(d.buttons)}`); const via3 = await clickDialogButton(kind); trail.push(`upsell ${kind}=${via3}`); await page.wait(4); d = unwrap(await page.evaluate(dlgJs)); }
    }
    if (d?.dialog && !d.confirm) {
      throw new CommandExecutionError(`点完下单键弹了认不出的框，停住不盲点：「${d.head}」 按钮=${JSON.stringify(d.buttons)}`);
    }
    // 最终确认：要么在确认框里，要么页面上的下单键变成了「…注文を確定する」
    let via2 = '';
    if (d?.dialog && d.confirm) {
      via2 = await clickDialogButton('confirm');
      trail.push(`confirm=「${d.confirm.text}」 click2=${via2}`);
      await page.wait(8);
    } else if (UI.placeFinal.test(d?.pageBtnText || '') && !UI.placeStep1.test(d?.pageBtnText || '') && d.pageBtnText !== dom.placeBtnText) {
      // 只有键上的字真的变了（第一步 →「…注文を確定する」）才按第二下。字没变 = 可能第一下已经下成、页面还没跳走，再按就是第二单
      via2 = await nativeClickSelector(page, '[data-testid=place-order-btn]');
      trail.push(`final=「${d.pageBtnText}」 click2=${via2}`);
      await page.wait(8);
    } else if (d?.pageBtnText && d.pageBtnText === dom.placeBtnText && !UI.placeStep1.test(d.pageBtnText)) {
      trail.push(`page-btn unchanged「${d.pageBtnText.slice(0, 30)}」→ 不按第二下，去查订单`);
    } else if (UI.placeStep1.test(d?.pageBtnText || '')) {
      // 页面键没变、也没弹框 → 再点一次（upsell 跳过后有时要再按一下）
      via2 = await nativeClickSelector(page, '[data-testid=place-order-btn]');
      trail.push(`again=「${d.pageBtnText}」 click2=${via2}`);
      await page.wait(5);
      const d2 = unwrap(await page.evaluate(dlgJs));
      if (d2?.dialog && d2.confirm) { const v3 = await clickDialogButton('confirm'); trail.push(`confirm=「${d2.confirm.text}」 click3=${v3}`); await page.wait(8); }
      else if (d2?.dialog) throw new CommandExecutionError(`再点一次后弹了认不出的框，停住：「${d2.head}」 按钮=${JSON.stringify(d2.buttons)}`);
      else if (UI.placeFinal.test(d2?.pageBtnText || '') && !UI.placeStep1.test(d2?.pageBtnText || '') && d2.pageBtnText !== d.pageBtnText) { const v3 = await nativeClickSelector(page, '[data-testid=place-order-btn]'); trail.push(`final=「${d2.pageBtnText}」 click3=${v3}`); await page.wait(8); }
    }
    const url = await currentUrl(page);
    // ── 成功判定：不能只读一次。2026-08-22 22:17 实测——单其实下成了，但点完立刻读 getActiveOrdersV1
    //    仍是 0、页面还被弹回店页，于是误报 unknown。假阴性比假阳性危险得多（人会重按 → 重复下单）。
    //    唯一可信锚点：active orders 里出现 uuid == draftId（Uber 的订单 uuid 就是 draft uuid）。轮询到出现为止。
    let activeAfter = activeBefore, hitDraft = false;
    for (let i = 0; i < 8; i++) {
      try {
        const orders = (await api(page, 'getActiveOrdersV1', {}))?.orders || [];
        activeAfter = orders.length;
        hitDraft = orders.some((o) => JSON.stringify(o || {}).includes(draftId));
        if (hitDraft || activeAfter > activeBefore) break;
      } catch { /* ignore */ }
      await page.wait(2);
    }
    const placed = hitDraft || /\/orders?\//.test(url) || activeAfter > activeBefore;
    return [{
      status: placed ? 'placed' : 'unknown',
      draft_id: draftId,
      total: cp.totalText,
      order_url: /\/orders?\//.test(url) ? url.split('?')[0] : '',
      detail: `${trail.join(' → ')} | active ${activeBefore}→${activeAfter}${hitDraft ? ' draft✓' : ''} url=${url.split('?')[0]}`,
    }];
  },
});
