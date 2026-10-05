import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { UE, storeUrl, shortIdFromUrl, uuidFromShortId, currentUrl, unwrap, requireLogin } from './_shared.js';
import { PRICE, PRICE_LEAD, UI } from './_ui.js';

// 店页菜单（DOM：li[data-testid^=store-item-]）。item id 带上店的短 id（store:item），add 时不用再传店。
cli({
  site: 'ubereats',
  name: 'store',
  access: 'read',
  description: 'Uber Eats 店页菜单：商品 id（store:item）/ 名 / 价 / 分区 / 能否快捷加购 / 售罄',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'id', positional: true, required: true, help: '店的短 id（search 给的，如 AbCdEfGhIjKlMnOpQrStUv）或店页 URL' },
    { name: 'limit', type: 'int', default: 60, help: '最多返回多少条菜' },
    { name: 'section', help: '只看某个分区（关键词匹配，如 "セット"）' },
    { name: 'query', help: '只看菜名含关键词的（超市 / 便利店 / 药店：走店内搜索，按相关度回）' },
  ],
  columns: ['id', 'title', 'price', 'section', 'quick', 'sold_out'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    await page.goto(storeUrl(kwargs.id));
    await page.wait(5);
    await requireLogin(page);
    const url = await currentUrl(page);
    const storeId = shortIdFromUrl(url);
    if (!storeId) throw new CommandExecutionError(`not a store page: ${url}`);
    await page.autoScroll({ times: 2, delayMs: 600 });
    const items = unwrap(await page.evaluate(`(() => {
      const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
      const storeTitle = t(document.querySelector('h1'));
      const lis = [...document.querySelectorAll('li[data-testid^="store-item-"]')];
      const seen = new Set();
      const items = [];
      for (const li of lis) {
        const uuid = li.dataset.testid.replace('store-item-', '');
        if (seen.has(uuid)) continue; seen.add(uuid);
        const a = li.querySelector('a');
        const txt = t(a || li);
        const price = (txt.match(${PRICE}) || [])[0] || '';
        const title = txt.split(${PRICE})[0].replace(${UI.soldOutTail}, '').replace(/•/g, '').trim();
        const sec = li.closest('[data-testid=store-catalog-section-vertical-grid]')?.querySelector('[data-testid=catalog-section-title]');
        items.push({ uuid, title, price, section: t(sec), quick: !!li.querySelector('[data-testid=quick-add-button]'), sold_out: ${UI.soldOut}.test(txt) });
      }
      return { storeTitle, items, grocery: !lis.length && !!document.querySelector('[data-testid^="store-item-"]') };
    })()`));
    let rows = (items?.items || []).map((it) => ({ id: `${storeId}:${it.uuid}`, title: it.title, price: it.price, section: it.section, quick: it.quick, sold_out: it.sold_out }));
    let searched = false;
    if (items?.grocery) {
      // 超市 / 便利店 / 药店（2026-10-05 侦察）：商品卡是 div[data-testid=store-item-]、链接包在外层 <a>，文字价在前
      //（「10% オフ ￥161 ￥179 アクエリアス(950ml)」/「$3.49 $3.99 Gatorade」）；首页只有几排推荐，整店要走店内搜索页——真店名路径 + /店 uuid?storeSearchQuery=
      //（短 id 的 /store/s/ 会跳转、把参数丢掉）。id 带上货架 uuid（store:item:section:subsection），add 靠它直接开商品框
      if (kwargs.query) {
        // 真店名路径要从页面上读：opencli 的 getCurrentUrl 回的是上一次 goto 的地址（/store/s/…），不是跳转后的
        const path = String(unwrap(await page.evaluate('location.pathname')) || '').replace(/\/$/, '');
        await page.goto(`${UE}${path}/${uuidFromShortId(storeId)}?diningMode=DELIVERY&storeSearchQuery=${encodeURIComponent(String(kwargs.query))}`);
        await page.wait(5);
        searched = true;
      }
      const g = unwrap(await page.evaluate(`(() => {
        const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
        const seen = new Set(); const out = [];
        for (const el of document.querySelectorAll('[data-testid^="store-item-"]')) {
          const uuid = el.dataset.testid.replace('store-item-', '');
          if (seen.has(uuid)) continue; seen.add(uuid);
          let ctx = {};
          try { ctx = JSON.parse(decodeURIComponent(new URLSearchParams((el.closest('a')?.getAttribute('href') || '').split('?')[1] || '').get('modctx') || '%7B%7D')); } catch (e) { /* 没上下文就只给 store:item */ }
          const txt = t(el);
          const sec = el.closest('[data-testid=store-desktop-catalog-section-carousel]')?.querySelector('[data-testid=catalog-section-title]');
          out.push({ uuid, title: txt.replace(${PRICE_LEAD}, '').replace(${UI.orderedBefore}, '').replace(${UI.soldOutTail}, '').trim(), price: (txt.match(${PRICE}) || [''])[0], section: t(sec), quick: !!el.querySelector('[data-testid=quick-add-button]'), sold_out: ${UI.soldOut}.test(txt), sectionUuid: ctx.sectionUuid || '', subsectionUuid: ctx.subsectionUuid || '' });
        }
        return out;
      })()`));
      rows = (g || []).map((it) => ({ id: `${storeId}:${it.uuid}${it.sectionUuid && it.subsectionUuid ? `:${it.sectionUuid}:${it.subsectionUuid}` : ''}`, title: it.title, price: it.price, section: it.section, quick: it.quick, sold_out: it.sold_out }));
    }
    if (kwargs.section) rows = rows.filter((r) => r.section.includes(String(kwargs.section)));
    // 店内搜索按相关度回（搜「風邪薬」回的是パブロン），不再按字面过滤
    if (kwargs.query && !searched) rows = rows.filter((r) => r.title.includes(String(kwargs.query)));
    if (!rows.length) throw new EmptyResultError(`no menu items on ${items?.storeTitle || storeId}${items?.grocery && !kwargs.query ? '（超市 / 药店首页只有几排推荐——带 --query 按商品名搜）' : ''}`);
    return rows.slice(0, Math.max(1, Number(kwargs.limit) || 60));
  },
});
