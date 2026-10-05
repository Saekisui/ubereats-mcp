import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { UE, storeUrl, unwrap, uuidFromShortId, requireLogin, loadCarts, nativeClickSelector } from './_shared.js';

// 加购（写）：id = store:item（store 命令给的）。
//  - 没有 spec、qty=1、有快捷加购 → 原生点 quick-add-button（默认选项）
//  - 否则开模态框：选项是多级的（比如 套餐 → 选「ドリンクM」之后才冒出「コカ・コーラ / 爽健美茶…」），
//    而且多级选项会钻进子页（只有「戻る / 保存」两个按钮），选完要点「保存」回主页面 add 按钮才亮。
//    所以迭代：每轮按 spec 关键词在当前可见的 option label 里找并点选、必选组没选的补第一个、子页有「保存」就按一下回主页面，直到一轮没有新动作；
//    设数量；原生点 add-to-cart-button。加完用 getDraftOrdersByEaterUuidV1 核实真的进了购物车。
cli({
  site: 'ubereats',
  name: 'add',
  access: 'write',
  description: 'Uber Eats 加购：store:item id，--spec 选项关键词（空格分隔，多级选项会逐级匹配），--qty 数量',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'id', positional: true, required: true, help: 'store:item（store 命令输出的 id；超市 / 药店的是 store:item:section:subsection）' },
    { name: 'spec', help: '选项关键词，空格分隔，如 "コーラ ポテト(L)"（label 含关键词即选；多级选项逐级匹配）' },
    { name: 'qty', type: 'int', default: 1, help: '数量 1-10' },
  ],
  columns: ['status', 'store', 'item', 'qty', 'draft_id', 'cart_items', 'via'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    const [storeId, itemUuid, sectionUuid, subsectionUuid] = String(kwargs.id).split(':');
    if (!storeId || !itemUuid) throw new CommandExecutionError('id must be store:item (from `ubereats store`)');
    const qty = Math.max(1, Math.min(10, Number(kwargs.qty) || 1));
    const specWords = String(kwargs.spec || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);

    await page.goto(storeUrl(storeId));
    await page.wait(5);
    await requireLogin(page);
    const liSel = `li[data-testid="store-item-${itemUuid}"]`;
    let info = unwrap(await page.evaluate(`(() => { const li = document.querySelector(${JSON.stringify(liSel)}); if (!li) return null; li.scrollIntoView({ block: 'center', behavior: 'instant' }); const txt = li.innerText.replace(/\\s+/g, ' '); return { title: txt.split(/[￥¥]/)[0].replace(/売り切れ.*$/, '').trim(), soldOut: /売り切れ/.test(txt), quick: !!li.querySelector('[data-testid=quick-add-button]'), store: (document.querySelector('h1') || {}).innerText || '' }; })()`));
    if (!info && sectionUuid && subsectionUuid) {
      // 超市 / 药店的商品多半不在首页：带货架 uuid 的 quickView 深链直接开商品框（四个 uuid 少一个都开不出来，10/05 侦察）
      const ctx = encodeURIComponent(encodeURIComponent(JSON.stringify({ storeUuid: uuidFromShortId(storeId), sectionUuid, subsectionUuid, itemUuid })));
      // 真店名路径从页面读（getCurrentUrl 回的是 goto 的 /store/s/… 短地址，它一跳转就丢参数）
      await page.goto(`${UE}${unwrap(await page.evaluate('location.pathname'))}?diningMode=DELIVERY&mod=quickView&modctx=${ctx}`);
      await page.wait(5);
      info = unwrap(await page.evaluate(`(() => { const dlg = document.querySelector('[role=dialog]'); const add = dlg && dlg.querySelector('[data-testid=add-to-cart-button]'); if (!add) return null; return { title: ((dlg.querySelector('[data-testid=menu-item-title]') || dlg.querySelector('h1') || {}).innerText || '').trim(), soldOut: /売り切れ/.test(add.innerText), quick: false, store: (document.querySelector('h1') || {}).innerText || '', deep: true }; })()`));
    }
    if (!info) throw new CommandExecutionError(`item ${itemUuid} not on this store page (scroll / wrong store?)`);
    if (info.soldOut) throw new CommandExecutionError(`「${info.title}」売り切れ`);

    const before = await loadCarts(page);
    let via;
    if (!specWords.length && qty === 1 && info.quick) {
      via = `quick-add:${await nativeClickSelector(page, `${liSel} [data-testid=quick-add-button]`)}`;
    } else {
      if (!info.deep) { // 深链来的商品框已经开着
        // 一张商品卡常有 2–4 个 <a>，page.click 会报 selector 歧义（8/22–8/26 带 spec 的加购 15 次死了 7 次）——挑第一个有尺寸的原生点
        await nativeClickSelector(page, `${liSel} a`);
        await page.wait(3);
      }
      // 一轮 = 在当前可见选项里：按 spec 选 + 必选组补第一个。返回这轮做了什么。
      const passJs = (remaining) => `(() => {
        const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
        const dlg = document.querySelector('[role=dialog]');
        if (!dlg) return { ok: false, reason: 'no dialog' };
        const words = ${JSON.stringify(remaining)};
        const labels = [...dlg.querySelectorAll('[data-testid=customization-option-label]')];
        const inputOf = (lab) => lab.closest('label')?.querySelector('input') || (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : null) || lab.parentElement?.querySelector('input') || lab.closest('li, div')?.querySelector('input');
        const picked = []; const stillMissing = [];
        for (const w of words) {
          const lab = labels.find((l) => t(l).includes(w));
          if (!lab) { stillMissing.push(w); continue; }
          const input = inputOf(lab);
          if (input && input.checked) { picked.push(t(lab).slice(0, 40) + '(already)'); continue; }
          (lab.closest('label') || lab).click();
          if (input && !input.checked) input.click();
          picked.push(t(lab).slice(0, 40));
        }
        const filled = [];
        for (const g of dlg.querySelectorAll('[data-testid=customization-pick-one]')) {
          const inputs = [...g.querySelectorAll('input')];
          if (!inputs.length || inputs.some((i) => i.checked)) continue;
          if (!/必須|required/i.test(t(g))) continue;
          const first = inputs[0];
          (first.closest('label') || first).click();
          if (!first.checked) first.click();
          filled.push(t(g).split(/\\s+\\d+\\s*個/)[0].slice(0, 30));
        }
        const saveBtn = [...dlg.querySelectorAll('button')].find((b) => /^保存|^完了|^次へ/.test(t(b)) && !/閉じる/.test(t(b)));
        const addBtn = dlg.querySelector('[data-testid=add-to-cart-button]');
        return { ok: true, picked, filled, stillMissing, subpage: !!saveBtn && !addBtn, saveText: saveBtn ? t(saveBtn).slice(0, 20) : null };
      })()`;
      const clickSaveJs = `(() => { const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : ''); const dlg = document.querySelector('[role=dialog]'); const b = dlg && [...dlg.querySelectorAll('button')].find((x) => /^保存|^完了|^次へ/.test(t(x))); if (!b) return false; b.click(); return true; })()`;
      let remaining = [...specWords];
      const pickedAll = []; const filledAll = []; let saves = 0;
      for (let round = 0; round < 8; round += 1) {
        const r = unwrap(await page.evaluate(passJs(remaining)));
        if (!r?.ok) throw new CommandExecutionError(`item modal did not open (${r?.reason || '?'})`);
        pickedAll.push(...r.picked); filledAll.push(...r.filled);
        remaining = r.stillMissing;
        let acted = r.picked.length > 0 || r.filled.length > 0;
        if (r.subpage) {
          // 钻进了子页：选完（上面已选）→ 点「保存」回主页面
          await page.wait(0.8);
          if (unwrap(await page.evaluate(clickSaveJs))) { saves += 1; acted = true; }
        }
        if (!acted) break; // 这轮没动作 → 稳定了
        await page.wait(1.5); // 等下一级选项 / 主页面渲染
      }
      if (remaining.length) throw new CommandExecutionError(`spec not found in options: ${remaining.join(' / ')}（已选：${pickedAll.join('、') || '-'}；先 ubereats store 看有哪些选项名）`);
      const fin = unwrap(await page.evaluate(`(() => {
        const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
        const dlg = document.querySelector('[role=dialog]'); if (!dlg) return { ok: false };
        let qtySet = null;
        const sel = dlg.querySelector('select');
        if (sel && ${qty} > 1) {
          const opt = [...sel.options].find((o) => o.textContent.trim() === String(${qty}));
          if (opt) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); qtySet = ${qty}; }
        }
        const btn = dlg.querySelector('[data-testid=add-to-cart-button]');
        const unselected = [...dlg.querySelectorAll('[data-testid=customization-pick-one]')].filter((g) => /必須|required/i.test(t(g)) && ![...g.querySelectorAll('input')].some((i) => i.checked)).map((g) => t(g).slice(0, 30));
        return { ok: true, qtySet, btnText: t(btn), btnDisabled: !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true', unselected };
      })()`));
      if (!fin?.ok) throw new CommandExecutionError('item modal vanished before add');
      if (qty > 1 && !fin.qtySet) throw new CommandExecutionError(`数量 ${qty} 没设上（框里找不到数量下拉）——没加购，免得只加了 1 份还报成功`);
      if (fin.btnDisabled) throw new CommandExecutionError(`add button disabled — required option still unselected: ${fin.unselected.join(' / ') || '?'}（picked: ${pickedAll.join('、') || '-'}）`);
      await page.wait(1);
      via = `modal:${await nativeClickSelector(page, '[role=dialog] [data-testid=add-to-cart-button]')}${pickedAll.length ? ` picked=${pickedAll.join('|')}` : ''}${filledAll.length ? ` autofill=${filledAll.join('|')}` : ''}${saves ? ` saves=${saves}` : ''}${fin.qtySet ? ` qty=${fin.qtySet}` : ''}`;
    }
    // 弹窗可能晚到、也可能连环（商品详情框 → 「新しい注文を作成」确认框）：轮询处理，有按钮就按。
    // 加购键只在快捷加购那条路上补按（详情框晚到）；模态框那条路上面已经按过，框没及时关时再按就是加两份
    const allowAdd = via.startsWith('quick-add');
    const dlgHandlerJs = `(() => { const dlg = document.querySelector('[role=dialog]'); if (!dlg) return null; const add = ${allowAdd} ? dlg.querySelector('[data-testid=add-to-cart-button]') : null; if (add && !add.disabled && add.getAttribute('aria-disabled') !== 'true') { add.click(); return { clicked: add.innerText.trim() }; } const b = [...dlg.querySelectorAll('button')].find((x) => /新しい注文|新規|作成|続行|OK|はい/.test(x.innerText)); if (!b) return { text: dlg.innerText.replace(/\\s+/g, ' ').slice(0, 160) }; b.click(); return { clicked: b.innerText.trim() }; })()`;
    const confirmClicks = []; let confirm = null; let quietRounds = 0;
    for (let i = 0; i < 5 && quietRounds < 2; i += 1) {
      await page.wait(2.5);
      const r = unwrap(await page.evaluate(dlgHandlerJs));
      if (r?.clicked) { confirmClicks.push(r.clicked); confirm = r; quietRounds = 0; } else { confirm = confirm || r; quietRounds += 1; }
    }
    if (confirmClicks.length) confirm = { clicked: confirmClicks.join('>') };

    const after = await loadCarts(page);
    const mine = after.find((c) => c.item_titles.some((t) => t && info.title && (t.includes(info.title.slice(0, 12)) || info.title.includes(t.slice(0, 12)))));
    const grew = mine && (before.find((c) => c.draft_id === mine.draft_id)?.item_count ?? 0) < mine.item_count;
    return [{
      status: mine ? (grew ? 'added' : 'in-cart(unchanged?)') : 'not-found-in-cart',
      store: mine?.store || info.store || '',
      item: info.title,
      qty,
      draft_id: mine?.draft_id || '',
      cart_items: mine ? mine.items : '',
      via: via + (confirm?.clicked ? ` confirm=${confirm.clicked}` : confirm?.text ? ` dialog=${confirm.text}` : ''),
    }];
  },
});
