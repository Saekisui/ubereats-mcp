import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { UE, LOCALE, ensureUE, requireLogin, api, shortIdFromUrl } from './_shared.js';
import { PRICE, UI } from './_ui.js';

cli({
  site: 'ubereats',
  name: 'search',
  access: 'read',
  description: 'Uber Eats 搜店 / 搜菜 / 搜商品（账号当前的配送地址；页内 getSearchFeedV1）',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'query', positional: true, required: true, help: '关键词（店名 / 菜名）' },
    { name: 'limit', type: 'int', default: 10, help: '条数（max 40）' },
  ],
  columns: ['id', 'title', 'rating', 'eta', 'fare', 'items', 'url'],
  navigateBefore: false,
  func: async (page, kwargs) => {
    await ensureUE(page);
    await requireLogin(page);
    const limit = Math.max(1, Math.min(40, Number(kwargs.limit) || 10));
    const data = await api(page, 'getSearchFeedV1', {
      userQuery: String(kwargs.query), date: '', startTime: 0, endTime: 0, carouselId: '', sortAndFilters: [],
      pageInfo: { offset: 0, pageSize: Math.max(20, limit) }, vertical: 'ALL',
    });
    const rows = [];
    for (const fi of data?.feedItems || []) {
      // 按商品名搜（ポカリ / 風邪薬）回的是 MINI_STORE_WITH_ITEMS：超市 / 药店 + 命中的几件。以前只认 fi.store，全丢了（10/05 侦察）
      const s = fi.store || fi.miniStoreWithItems?.store; if (!s) continue;
      const meta = (s.meta || []).map((m) => m?.text).filter(Boolean);
      const eta = meta.find((t) => /分|min/.test(t)) || '';
      const fare = meta.find((t) => (UI.deliveryFee.test(t) || PRICE.test(t)) && t !== eta) || '';
      const path = s.actionUrl || '';
      rows.push({
        id: shortIdFromUrl(path) || s.storeUuid || '',
        title: s.title?.text || s.title || '',
        rating: s.rating?.text || '',
        eta,
        fare,
        items: (fi.miniStoreWithItems?.items || []).slice(0, 3).map((it) => `${it.title?.text || ''} ${it.subtitles?.[0]?.text || ''}`.trim()).join('；'),
        url: path ? `${UE}${LOCALE.prefix && !path.startsWith(`${LOCALE.prefix}/`) ? LOCALE.prefix : ''}${path}` : '',
      });
      if (rows.length >= limit) break;
    }
    if (!rows.length) throw new EmptyResultError(`no stores for "${kwargs.query}"`);
    return rows;
  },
});
