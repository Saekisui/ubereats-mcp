import { cli, Strategy } from '@jackwener/opencli/registry';
import { ensureUE, requireLogin, loadCarts } from './_shared.js';

// 购物车们（Uber Eats 一店一车，可并存多车）：draft_id 就是 review / place 要的。
cli({
  site: 'ubereats',
  name: 'cart',
  access: 'read',
  description: 'Uber Eats 购物车（所有店的草稿订单：draft_id / 店 / 品 / 数量，按最近改动排序）',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [],
  columns: ['draft_id', 'store', 'item_count', 'items', 'modified'],
  navigateBefore: false,
  func: async (page) => {
    await ensureUE(page);
    await requireLogin(page);
    const carts = await loadCarts(page);
    if (!carts.length) return [{ draft_id: '', store: '（购物车是空的）', item_count: 0, items: '', modified: '' }];
    return carts.map(({ item_titles, store_id, ...rest }) => rest);
  },
});
