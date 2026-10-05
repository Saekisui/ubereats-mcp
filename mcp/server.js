#!/usr/bin/env node
// ubereats-jp MCP server —— 让 AI 在用户自己的 Chrome 里帮忙点 Uber Eats（日本站）。
//
// stdio JSON-RPC 2.0，每行一个 message，stderr 走日志。直接调 OpenCLI（用户的真 Chrome + 真登录态），内核在 core.js。
// 工具：ue_policy / ue_search / ue_store / ue_add / ue_cart / ue_review / ue_place / ue_orders
// 下单链：ue_review 发 confirm_token → 用户在对话里明确点头 → ue_place（再读一次结算快照，总价 / 店名 / 购物车一致、不超上限才下）。
//
// 启动：node mcp/server.js    环境变量：OPENCLI_BIN（可选，默认 ~/.npm-global/bin/opencli）、UE_POLICY / UE_LEDGER（可选，改策略 / 账本路径）
import readline from "node:readline";
import {
  CMD, readPolicy, appendLedger, spentToday, issueToken, consumeToken, peekToken, assertCanPlace, runOpencli, fmtRows,
} from "./core.js";

function log(...args) {
  process.stderr.write(`[ubereats-jp] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}
function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }

const TOOLS = [
  {
    name: "ue_policy",
    description: "Read the ordering policy: whether ordering is enabled, per-order / per-day caps (JPY), how much was already spent today, and whether the user is logged in to Uber Eats in Chrome.\n\nUse this when:\n- You're about to add to cart or place an order — check the caps first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ue_search",
    description: "Search Uber Eats Japan (delivers to the account's current address). Works with store names, dishes and products. Product searches (e.g. 'ポカリスエット', '風邪薬') return supermarkets / drugstores together with the matching items and prices.\n\nUse this when:\n- The user asks for delivery ('点个 X' / 'order me X'). Delivery is real food and real money — don't start a delivery order on your own initiative.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词（店名 / 菜名 / 商品名）" },
        limit: { type: "number", description: "条数，默认 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "ue_store",
    description: "A store's menu: item ids, names, prices, sections, quick-add, sold out.\n\nNotes:\n- Supermarkets / convenience stores / drugstores (ローソン, マルエツ, ウエルシア…) only show a few shelves on their front page — pass query to search inside the store. Their item ids are long (store:item:section:subsection); pass them to ue_add unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "店 id（ue_search 给的短 id）或店页 URL" },
        query: { type: "string", description: "店里按商品名找（超市 / 药店走店内搜索，按相关度；餐厅按菜名过滤）" },
      },
      required: ["id"],
    },
  },
  {
    name: "ue_add",
    description: "Add one item to the cart (a write action). spec = option keywords, space-separated, one per option group (e.g. 'コーラ ポテト(L)'; multi-level options are matched level by level); qty = quantity 1-10. Confirm with ue_cart afterwards.\n\nNotes:\n- Uber Eats keeps one cart per store; several carts can exist at once.\n- Adding is not buying. Confirm with the user before adding anything.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "商品 id（ue_store 给的 store:item，或超市的 store:item:section:subsection）" },
        spec: { type: "string", description: "选项关键词，空格分隔" },
        qty: { type: "number", description: "数量 1-10" },
      },
      required: ["id"],
    },
  },
  {
    name: "ue_cart",
    description: "List the carts (one per store): draft_id, store, items, most recently changed first.\n\nUse this when:\n- You've just added something and want to confirm it landed, or need the draft_id for ue_review.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ue_review",
    description: "Checkout snapshot for one cart — the only trusted price: store / items / options / subtotal / every fee / total / ETA / delivery address / payment method. Read from Uber's checkout API keyed by draft (not the page), with two independent anchors that throw instead of mixing two carts. Returns a confirm_token (valid ~10 min, single use).\n\nUse this when:\n- Before placing an order: show the user this exactly as returned; only after they say yes, call ue_place.",
    inputSchema: { type: "object", properties: { draft: { type: "string", description: "可选：哪一辆购物车（ue_cart 给的 draft_id；缺省 = 最近改动的）" } } },
  },
  {
    name: "ue_place",
    description: "Place the order. Requires the confirm_token from ue_review; the checkout snapshot is re-read and must still match (total / store / cart) and be within the per-order / per-day caps — otherwise it refuses.\n\nUse this when:\n- The user has explicitly said yes to the exact review you showed them. Only then.\n\nNotes:\n- If it comes back status unknown, or with any error after the gates passed, that does NOT mean it failed — the order may well have gone through. Check ue_orders first and tell the user what you find.\n- Never call ue_place again for the same cart: a second press is a second order and a second charge.",
    inputSchema: { type: "object", properties: { confirm_token: { type: "string" } }, required: ["confirm_token"] },
  },
  {
    name: "ue_orders",
    description: "Active orders and delivery progress.\n\nUse this when:\n- Right after ue_place, to confirm the order landed — always when ue_place came back unknown or with an error.\n- While the food is on the way, if the user asks where it is.",
    inputSchema: { type: "object", properties: {} },
  },
];

// 把 review 输出（field/value 表）里的 总价 / 店名 / draft 抠出来
function pickReviewFacts(rows) {
  const obj = Array.isArray(rows) && rows.every((r) => r && "field" in r)
    ? Object.fromEntries(rows.map((r) => [String(r.field), r.value]))
    : (Array.isArray(rows) ? rows[0] || {} : rows || {});
  const num = (v) => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && String(v ?? "") !== "" ? n : NaN; };
  return { total: num(obj.total), store: String(obj.store ?? ""), draft: String(obj.draft_id ?? "") };
}

// place 在 adapter 里给了 150 秒（opencli 再加 30 秒缓冲），这边不能先掐
const run = (action, args = {}) => runOpencli(CMD[action](args), action === "place" ? { timeoutMs: 240_000 } : undefined);

async function callTool(name, args) {
  args = args || {};
  const entry = { tool: name, args };
  try {
    const result = await dispatch(name, args);
    appendLedger({ ...entry, ok: true, summary: result.summary, total: result.total });
    return { content: [{ type: "text", text: result.text }] };
  } catch (e) {
    appendLedger({ ...entry, ok: false, error: e.message });
    throw e;
  }
}

async function dispatch(name, args) {
  const policy = readPolicy();
  if (name === "ue_policy") {
    let login = "?";
    try { const who = await run("whoami"); login = (Array.isArray(who) ? who[0] : who)?.logged_in === false ? "未登录（在 Chrome 里登一下 ubereats.com）" : "已登录"; }
    catch (e) { login = `查不到（${e.message.slice(0, 60)}）`; }
    return {
      text: `下单：${policy.enabled ? "开" : "关"} · 单笔上限 ${policy.maxPerOrder ?? "无"} · 当日上限 ${policy.maxPerDay ?? "无"} JPY · 今天已下 ${spentToday()} · ${login}\ntoken 有效期 ${policy.tokenTtlMin} 分钟。地址 / 支付只用账号默认项；价格只信 ue_review。`,
      summary: "policy",
    };
  }
  if (name === "ue_search") {
    if (!args.query) throw new Error("query 是必填");
    const rows = await run("search", { query: args.query, limit: args.limit });
    return { text: fmtRows(rows, { limit: Number(args.limit) || 10 }), summary: `search ${args.query}` };
  }
  if (name === "ue_store") {
    if (!args.id) throw new Error("id 是必填");
    const rows = await run("store", { id: String(args.id), query: args.query });
    return { text: fmtRows(rows, { limit: 60 }), summary: `store ${args.id}${args.query ? ` ${args.query}` : ""}` };
  }
  if (name === "ue_add") {
    if (!args.id) throw new Error("id 是必填");
    const rows = await run("add", { id: String(args.id), spec: args.spec, qty: args.qty });
    return { text: `加购结果：\n${fmtRows(rows)}`, summary: `add ${args.id}${args.spec ? ` ${args.spec}` : ""}` };
  }
  if (name === "ue_cart") {
    return { text: fmtRows(await run("cart")), summary: "cart" };
  }
  if (name === "ue_review") {
    const rows = await run("review", { draft: args.draft });
    const { total, store, draft } = pickReviewFacts(rows);
    const token = issueToken({ total, store, draft, ttlMin: policy.tokenTtlMin });
    return {
      text: `结算快照（只信这个价）：\n${fmtRows(rows)}\n\n总价 ${Number.isFinite(total) ? total : "读不到"} JPY${store ? ` · 店「${store}」` : ""}\n用户点头后：ue_place(confirm_token="${token}")（${policy.tokenTtlMin} 分钟内有效；总价 / 店名变了会拒）`,
      summary: `review total=${total}`, total: Number.isFinite(total) ? total : undefined,
    };
  }
  if (name === "ue_place") {
    if (!args.confirm_token) throw new Error("confirm_token 是必填——先 ue_review");
    // 再读一次结算快照（同一辆车）：总价 / 店名必须跟 review 时一致，再过硬门
    const t0 = peekToken(args.confirm_token);
    if (!t0) throw new Error("confirm_token 不存在——先 ue_review 拿一个新的");
    const rows = await run("review", { draft: t0.draft || undefined });
    const { total, store, draft } = pickReviewFacts(rows);
    consumeToken(args.confirm_token, { total, store, draft });
    assertCanPlace({ policy, total, spentSoFar: spentToday() });
    let placed;
    try { placed = await run("place", { draft }); }
    catch (e) { throw new Error(`${e.message}\n⚠️ 下单状态不明：过了硬门之后的报错（含超时）都可能发生在按完最终确认之后。先 ue_orders 查有没有这单，查到才算数；别重按 ue_place。`); }
    return { text: `下单结果：\n${fmtRows(placed)}\n\n总价 ${total} JPY${store ? ` · 店「${store}」` : ""}。用 ue_orders 确认并跟配送。`, summary: `place total=${total} store=${store}`, total };
  }
  if (name === "ue_orders") {
    return { text: fmtRows(await run("orders")), summary: "orders" };
  }
  throw new Error(`unknown tool: ${name}`);
}

// ============ JSON-RPC 主循环 ============
async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ubereats-jp", version: "0.1.0" } } });
      return;
    }
    if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      const result = await callTool(name, args);
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "ping") { send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    log("error:", err.message);
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log("invalid JSON:", line.slice(0, 200)); return; }
  handle(msg);
});
