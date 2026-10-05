import { cli, Strategy } from '@jackwener/opencli/registry';
import { ensureUE, requireLogin, api } from './_shared.js';

// 进行中的订单（getActiveOrdersV1）。shape 没实单时看不全，字段尽量宽松取。
cli({
  site: 'ubereats',
  name: 'orders',
  access: 'read',
  description: 'Uber Eats 进行中的订单 / 配送状态',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [],
  columns: ['order_id', 'store', 'phase', 'status', 'eta', 'items', 'progress'],
  navigateBefore: false,
  func: async (page) => {
    await ensureUE(page);
    await requireLogin(page);
    const data = await api(page, 'getActiveOrdersV1', {});
    const orders = data?.orders || data?.activeOrders || [];
    if (!orders.length) return [{ order_id: '', store: '（没有进行中的订单）', phase: '', status: '', eta: '', items: '', progress: '' }];
    // 2026-08-22 22:13 实单结构：activeOrderOverview{title=店,subtitle=「￥1,926 の商品 2 点」,items[]}；
    // feedCards[type=status].status{title=ETA 区间, subtitle=配達予定時刻, titleSummary.summary.text=状态句, currentProgress/totalProgressSegments}；orderInfo.orderPhase
    return orders.map((o) => {
      const st = (o.feedCards || []).find((c) => c.type === 'status')?.status || {};
      const ov = o.activeOrderOverview || {};
      return {
        order_id: o.uuid || '',
        store: ov.title || o.orderInfo?.storeInfo?.title || '',
        phase: o.orderInfo?.orderPhase || '',
        status: st.titleSummary?.summary?.text || st.titleSummary?.text || '',
        eta: [st.subtitle, st.title].filter(Boolean).join(' '),
        items: (ov.items || []).map((it) => `${it.title}${it.quantity ? `×${it.quantity}` : ''}`).join('；') || ov.subtitle || '',
        progress: st.totalProgressSegments ? `${st.currentProgress}/${st.totalProgressSegments}` : '',
      };
    });
  },
});
