// 语言 / 币种 / 界面文字——纯函数，不依赖 opencli，测试直接 import。
//
// Uber Eats 网址里的 /jp 管的是「界面语言」，不是国家：同一个账号打开 /feed 是英文界面（localeCode=en-US），
// 打开 /jp/feed 是日文界面（localeCode=jp）；显示哪些店、什么币种，跟着账号的配送地址走。
// 所以默认走英文界面（全世界都有），UE_LOCALE=jp 换日文界面（实测最久的那套）。
// 认按钮的文字一律写成「日文 | 英文」的并集：界面语言配错了也照样认得出，认不出就停，不盲点。

const LOCALES = {
  en: { prefix: '', code: 'en-US' },
  jp: { prefix: '/jp', code: 'jp' },
};
export function localeOf(env = process.env) {
  const k = String(env.UE_LOCALE || 'en').toLowerCase();
  return LOCALES[k === 'ja' ? 'jp' : k] || LOCALES.en;
}

// ── 价格：¥1,520 / $12.34 / NT$1,234 / HK$58 / CA$9.50 / £9.99 / €12,34 / 12,34 € ──
export const PRICE = /(?:(?:[A-Z]{1,3}\$|R\$|[$€£¥￥₩₹฿])\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|zł|kr\b))/;
// 超市商品卡是「价在前、名在后」：去掉开头到最后一个价格为止的部分，剩下的就是品名
export const PRICE_LEAD = new RegExp(`^.*(?:${PRICE.source})\\s*`);
// 一段文字里的第一个价格 → 数字。小数点：两种分隔符都有时最后一个是小数点；只有逗号且后面正好两位 = 小数点；其余逗号是千分位。
export function parseMoney(text) {
  const m = String(text ?? '').match(PRICE);
  const raw = (m ? m[0] : String(text ?? '')).replace(/[^\d.,]/g, '');
  if (!/\d/.test(raw)) return null;
  let s = raw;
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /,\d{2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── 界面文字（日文 | 英文）。英文那半边是照 Uber 英文界面的常见写法写的，还没在真单上走过——认不出时会停下并把按钮列表带回来 ──
export const UI = {
  soldOut: /売り切れ|Sold out/i,
  soldOutTail: /(?:売り切れ|Sold out).*$/i,                  // 商品名后面挂着的「売り切れ…」整段切掉
  required: /必須|Required/i,
  subpageSave: /^(保存|完了|次へ|Save|Done|Next)/i,       // 多级选项钻进子页后回主页面的键
  subpageNot: /閉じる|Close|Back|戻る/i,
  newOrderOk: /新しい注文|新規|作成|続行|はい|^OK$|New order|Start new|^Create|^Continue|^Yes/i, // 加购后「要新开一单吗」那种确认框
  upsellHead: /注文の品をすべて揃える|一緒にいかが|おすすめ|追加しますか|Complete your order|You might also like|Add to your order|Frequently bought|Recommended for you/i,
  skip: /^(スキップ|このまま注文する|注文に進む|結構です|Skip|No thanks|Not now|Continue to checkout)$/i,
  closeAria: /^(閉じる|Close)$/i,
  editAria: /編集|Edit/i,
  placeFinal: /注文を確定|注文する|確定する|Place order|Confirm order/i,  // 最终确认键
  placeStep1: /最終確認し、次へ/,                                         // 日文界面的「第一步」键；英文界面有没有第一步还没见过，不猜
  addressHead: /選択した住所|保存済みの住所|配達先|お届け先|Selected address|Saved address|Delivery address|Deliver to/i,
  closedHead: /営業時間外|配達時間を指定|予約|Store is closed|is closed|Schedule (an |your )?order|Opens at/i,
  unavailableHead: /店舗を利用できません|注文を受け付けていません|Store unavailable|isn't accepting|not accepting orders|currently unavailable/i,
  pinHead: /住所情報|ピンの位置|ピンを調整|建物|部屋番号|Adjust pin|Confirm pin|Move pin|pin location|Address details/i,
  addressMissing: /現在地|住所を入力|Enter.*address|Current location/i,
  orderedBefore: /以前注文|Ordered before|Previously ordered/i,
  deliveryFee: /配達手数料|Delivery Fee|delivery fee/i,
};
