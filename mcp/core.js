// Uber Eats（日本站）MCP 的内核：命令表 / 策略 / 账本 / confirm_token / 下单硬门 / opencli 调用。
// 分层：
//   层 0 OpenCLI（真 Chrome + 用户的登录态）
//   层 1 站点脚本 = OpenCLI adapter（adapters/ubereats/，同步到 ~/.opencli/clis/ubereats/）
//   层 2 这里：工具面背后的硬安全门 / confirm_token / 账本 / opencli 调用
//   层 3 AI 在聊天里：问清 → 搜 → 选 → review → 用户点头 → place
// 纪律：价格只信结算快照（review）；地址 / 支付只用账号里存的默认项，对话里从不传卡号地址；
//       place 必须带 review 发的 token，且总价 / 店名与再读一次的结算快照一致、不超上限。
import { execFile } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
export const POLICY_PATH = process.env.UE_POLICY || join(PROJECT_ROOT, "policy.json");
export const LEDGER_PATH = process.env.UE_LEDGER || join(PROJECT_ROOT, "ledger.jsonl");

// ── 命令表：工具 → opencli 参数（不含 --format json）────────────────────
export const CHECKOUT_URL = "https://www.ubereats.com/jp/checkout";
export const CMD = {
  whoami: () => ["ubereats", "whoami"],
  search: ({ query, limit }) => ["ubereats", "search", query, "--limit", String(limit || 10)],
  store: ({ id, query }) => ["ubereats", "store", id, ...(query ? ["--query", query] : [])],
  add: ({ id, spec, qty }) => ["ubereats", "add", id, ...(spec ? ["--spec", spec] : []), ...(qty ? ["--qty", String(qty)] : [])],
  cart: () => ["ubereats", "cart"],
  review: ({ draft } = {}) => ["ubereats", "review", ...(draft ? ["--draft", draft] : [])],
  // --keep-tab：不加的话 opencli 命令一结束就关窗释放 tab。下单是写操作，提交请求 in-flight 时关窗有风险，失败现场也要留着看。
  place: ({ draft } = {}) => ["ubereats", "place", "--draft", String(draft || ""), "--keep-tab", "true"],
  orders: () => ["ubereats", "orders"],
};

// ── 策略（开关 / 上限）：policy.json 由用户本人改，AI 改不了 ─────────────
// 下单要明确打开：没有文件、或没写 enabled: true，一律不下单（搜 / 看 / 加购不受影响）
export function readPolicy(path = POLICY_PATH) {
  const p = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  const num = (v) => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    enabled: p.enabled === true,
    maxPerOrder: num(p.maxPerOrder),
    maxPerDay: num(p.maxPerDay),
    tokenTtlMin: Number(p.tokenTtlMin) > 0 ? Number(p.tokenTtlMin) : 10,
  };
}

// ── 账本：每次调用都记（含失败）────────────────────────────────────────
export function appendLedger(entry, path = LEDGER_PATH) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n", "utf-8");
  return line;
}
export function readLedger(path = LEDGER_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function jstDateKey(now = Date.now()) { return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10); }
// 当天（JST）已下单总额——只算 place 成功的
export function spentToday({ now = Date.now(), path = LEDGER_PATH } = {}) {
  const today = jstDateKey(now);
  return readLedger(path)
    .filter((e) => e.tool === "ue_place" && e.ok && jstDateKey(Date.parse(e.ts)) === today)
    .reduce((s, e) => s + (Number(e.total) || 0), 0);
}

// ── confirm_token：review 发、place 验 ───────────────────────────────
// 只存进程内存：MCP 进程一重启 token 全作废（本来就该重新 review 再下单）
const tokens = new Map();
export function issueToken({ total, store, draft, now = Date.now(), ttlMin = 10 }) {
  const token = `ok-${randomBytes(3).toString("hex")}`;
  tokens.set(token, { total: Number(total), store: String(store || ""), draft: String(draft || ""), issuedAt: now, expiresAt: now + ttlMin * 60_000, used: false });
  return token;
}
export function peekToken(token) { return tokens.get(token) || null; }
export function consumeToken(token, { total, store, draft, now = Date.now() }) {
  const t = tokens.get(token);
  if (!t) throw new Error("confirm_token 不存在——先 ue_review 拿一个新的");
  if (t.used) throw new Error("这个 confirm_token 已经用过了——再下一单要重新 ue_review");
  if (now > t.expiresAt) throw new Error(`confirm_token 过期了（${Math.round((now - t.issuedAt) / 60000)} 分钟前发的）——重新 ue_review`);
  if (!Number.isFinite(Number(total)) || Math.abs(Number(total) - t.total) > 0.009) throw new Error(`结算总价变了：review 时 ${t.total}，现在 ${total}——不下单，重新 ue_review 再给用户看`);
  if (store && t.store && store !== t.store) throw new Error(`店名变了：review 时「${t.store}」，现在「${store}」——不下单`);
  if (draft && t.draft && draft !== t.draft) throw new Error(`购物车变了：review 的是 ${t.draft}，现在是 ${draft}——不下单`);
  t.used = true;
  return t;
}
export function _resetTokens() { tokens.clear(); }

// ── 下单前的硬门（纯函数，好测）────────────────────────────────────────
export function assertCanPlace({ policy, total, spentSoFar }) {
  if (!policy.enabled) throw new Error("policy.json 里没打开下单（要写 \"enabled\": true，只有用户本人能改），不下单");
  const amount = Number(total);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`结算总价读不到或不是数字（${total}）——不下单`);
  if (policy.maxPerOrder != null && amount > policy.maxPerOrder) throw new Error(`单笔 ${amount} 超过上限 ${policy.maxPerOrder}（policy.json，只有用户本人能改）——不下单`);
  if (policy.maxPerDay != null && spentSoFar + amount > policy.maxPerDay) throw new Error(`今天已下 ${spentSoFar} + 这单 ${amount} 超过当日上限 ${policy.maxPerDay}——不下单`);
  return policy;
}

// ── opencli 调用（launchd / MCP 进程 PATH 里未必有 opencli，用 process.execPath 直接执行）──
export function resolveOpencliBin(env = process.env) {
  if (env.OPENCLI_BIN) return env.OPENCLI_BIN;
  const candidate = join(homedir(), ".npm-global", "bin", "opencli");
  return existsSync(candidate) ? candidate : "opencli";
}
// opencli 失败时输出是 yaml 信封：ok:false / error: { code, message }。message 多行时是折叠块（>- 或 |）——
// 只抓 `message:` 那一行会把正文吞成 ">-"。把后续缩进行一起收进来。
export function parseOpencliError(text, fallback = "") {
  const lines = String(text || "").split("\n");
  let reason = null;
  const i = lines.findIndex((l) => /^\s*message:/.test(l));
  if (i >= 0) {
    const first = lines[i].replace(/^\s*message:\s*/, "").trim();
    if (/^[>|][-+]?$/.test(first) || first === "") {
      const indent = (lines[i].match(/^\s*/) || [""])[0].length;
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (!l.trim()) { if (body.length) body.push(""); continue; }
        const ind = (l.match(/^\s*/) || [""])[0].length;
        if (ind <= indent) break;
        body.push(l.trim());
      }
      reason = body.join(first === "|" ? "\n" : " ").replace(/\s+$/, "");
    } else {
      reason = first.replace(/^['"]|['"]$/g, "");
    }
  }
  if (!reason) reason = lines.filter((l) => l.trim()).pop()?.trim() || fallback || "unknown error";
  const code = String(text || "").match(/^\s*code:\s*(\S+)/m)?.[1];
  return { reason, code };
}

export function runOpencli(args, { timeoutMs = 120_000, json = true } = {}) {
  const bin = resolveOpencliBin();
  const full = json ? [...args, "--format", "json"] : args;
  const nodeDir = dirname(process.execPath);
  const env = { ...process.env, PATH: `${nodeDir}:${process.env.PATH || "/usr/bin:/bin"}` };
  const useNode = bin.includes("/");
  return new Promise((resolve, reject) => {
    execFile(useNode ? process.execPath : bin, useNode ? [bin, ...full] : full, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const out = String(stdout || "").trim();
      if (err) {
        const { reason, code } = parseOpencliError(String(stderr || out || err.message), err.message);
        const e = new Error(`${reason}${code ? `（${code}）` : ""}`);
        e.code = code;
        return reject(e);
      }
      if (!json) return resolve(out);
      if (!out) return resolve([]);
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`opencli ${args.slice(0, 2).join(" ")} 输出不是 JSON：${out.slice(0, 120)}`)); }
    });
  });
}

// ── 输出整形：table-ish JSON → 给 AI 看的短文本 ─────────────────────────
export function fmtRows(rows, { limit = 20 } = {}) {
  if (!Array.isArray(rows)) {
    if (rows && typeof rows === "object") return Object.entries(rows).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
    return String(rows ?? "");
  }
  if (!rows.length) return "（空）";
  // review 这种 field/value 表 → 竖排
  if (rows.every((r) => r && "field" in r && "value" in r)) return rows.map((r) => `${r.field}: ${r.value}`).join("\n");
  return rows.slice(0, limit).map((r, i) => {
    // id 不截：超市商品 id 带货架 uuid（store:item:section:subsection）有 133 字，截了 ue_add 就用不了
    const parts = Object.entries(r).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v).replace(/\s+/g, " ").slice(0, k === "id" ? undefined : 120)}`);
    return `${i + 1}. ${parts.join(" | ")}`;
  }).join("\n");
}
