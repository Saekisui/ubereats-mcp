import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CMD, readPolicy, appendLedger, readLedger, spentToday,
  issueToken, consumeToken, _resetTokens, assertCanPlace, fmtRows, parseOpencliError,
} from "../mcp/core.js";

const NOW = Date.parse("2026-08-22T03:00:00.000Z"); // 12:00 JST
const POLICY = { enabled: true, maxPerOrder: 6000, maxPerDay: 12000, tokenTtlMin: 10 };

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "ubereats-jp-"));
  const p = join(dir, name);
  if (content !== undefined) writeFileSync(p, content);
  return p;
}

test("命令表：工具 → opencli 参数", () => {
  assert.deepEqual(CMD.search({ query: "ポカリ", limit: 5 }), ["ubereats", "search", "ポカリ", "--limit", "5"]);
  assert.deepEqual(CMD.store({ id: "s-1", query: "風邪薬" }), ["ubereats", "store", "s-1", "--query", "風邪薬"]);
  assert.deepEqual(CMD.store({ id: "s-1" }), ["ubereats", "store", "s-1"]);
  assert.deepEqual(CMD.add({ id: "it-1", qty: 2 }), ["ubereats", "add", "it-1", "--qty", "2"]);
  assert.deepEqual(CMD.review({ draft: "d-1" }), ["ubereats", "review", "--draft", "d-1"]);
  assert.deepEqual(CMD.review(), ["ubereats", "review"]);
  assert.deepEqual(CMD.place({ draft: "d-1" }), ["ubereats", "place", "--draft", "d-1", "--keep-tab", "true"], "place 带 --keep-tab true：下单 in-flight 时不许 opencli 收窗（--keep-tab <bool> 要值，否则吞掉 --format）");
});

test("策略读取：有文件按文件；没文件 / 没写 enabled: true = 不许下单", () => {
  const p = tmpFile("policy.json", JSON.stringify({ ...POLICY, maxPerDay: "" }));
  assert.deepEqual(readPolicy(p), { enabled: true, maxPerOrder: 6000, maxPerDay: null, tokenTtlMin: 10 });
  assert.equal(readPolicy(join(tmpdir(), "nope.json")).enabled, false, "没文件 → 关着（最保守）");
  assert.equal(readPolicy(tmpFile("policy.json", JSON.stringify({ maxPerOrder: 3000 }))).enabled, false, "没写 enabled → 关着");
});

test("账本：每次都记；当日已下单额只算 place 成功的、按 JST 日期", () => {
  const p = tmpFile("ledger.jsonl");
  appendLedger({ tool: "ue_place", ok: true, total: 1800 }, p);
  appendLedger({ tool: "ue_place", ok: false, total: 9999 }, p);
  appendLedger({ tool: "ue_review", ok: true, total: 2500 }, p);
  assert.equal(readLedger(p).length, 3);
  assert.equal(spentToday({ path: p }), 1800);
  // 昨天的不算
  writeFileSync(p, JSON.stringify({ ts: "2026-08-21T10:00:00.000Z", tool: "ue_place", ok: true, total: 5000 }) + "\n");
  assert.equal(spentToday({ now: NOW, path: p }), 0);
});

test("confirm_token：review 发 → place 验（总价 / 店名 / 购物车 / 过期 / 一次性 / 读不到价）", () => {
  _resetTokens();
  const token = issueToken({ total: 2380, store: "マクドナルド 新宿", draft: "d-1", now: NOW, ttlMin: 10 });
  assert.match(token, /^ok-[0-9a-f]{6}$/);
  assert.throws(() => consumeToken("ok-nope", { total: 2380, now: NOW }), /不存在/);
  assert.throws(() => consumeToken(token, { total: 2580, now: NOW }), /总价变了/);
  assert.throws(() => consumeToken(token, { total: NaN, now: NOW }), /总价变了/, "读不到价不许蒙混过关");
  assert.throws(() => consumeToken(token, { total: 2380, store: "别家", now: NOW }), /店名变了/);
  assert.throws(() => consumeToken(token, { total: 2380, draft: "d-2", now: NOW }), /购物车变了/);
  assert.throws(() => consumeToken(token, { total: 2380, now: NOW + 11 * 60_000 }), /过期/);
  const t = consumeToken(token, { total: 2380, store: "マクドナルド 新宿", now: NOW + 60_000 });
  assert.equal(t.used, true);
  assert.throws(() => consumeToken(token, { total: 2380, now: NOW + 60_000 }), /用过了/);
});

test("下单硬门：没打开拒、上限拒、读不到价拒、正常放行", () => {
  assert.throws(() => assertCanPlace({ policy: POLICY, total: 6001, spentSoFar: 0 }), /单笔 6001 超过上限 6000/);
  assert.throws(() => assertCanPlace({ policy: POLICY, total: 3000, spentSoFar: 9500 }), /当日上限/);
  assert.throws(() => assertCanPlace({ policy: POLICY, total: NaN, spentSoFar: 0 }), /读不到/);
  assert.throws(() => assertCanPlace({ policy: { ...POLICY, enabled: false }, total: 100, spentSoFar: 0 }), /没打开下单/);
  assert.equal(assertCanPlace({ policy: POLICY, total: 2380, spentSoFar: 1000 }).enabled, true);
});

test("fmtRows：列表 / field-value 表 / 对象 / 空 / 长 id 不截", () => {
  assert.equal(fmtRows([]), "（空）");
  assert.equal(fmtRows([{ field: "total", value: "2380" }, { field: "store", value: "M" }]), "total: 2380\nstore: M");
  assert.match(fmtRows([{ id: 1, title: "a b", price: "¥9", empty: "" }]), /^1\. id=1 \| title=a b \| price=¥9$/);
  assert.equal(fmtRows({ a: 1, b: { c: 2 } }), 'a: 1\nb: {"c":2}');
  const longId = `AAAAAAAAAAAAAAAAAAAAAA:${"a".repeat(36)}:${"b".repeat(36)}:${"c".repeat(36)}`; // 超市商品 id 133 字
  assert.ok(fmtRows([{ id: longId, title: "x".repeat(200) }]).includes(`id=${longId} |`));
  assert.ok(!fmtRows([{ id: 1, title: "x".repeat(200) }]).includes("x".repeat(121)));
});

test("parseOpencliError：单行 / 折叠多行（>-）/ 竖线（|）/ 无 message 兜底", () => {
  assert.deepEqual(parseOpencliError("ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: Not logged in\n  exitCode: 77"), { reason: "Not logged in", code: "AUTH_REQUIRED" });
  const folded = "ok: false\nerror:\n  code: COMMAND_EXEC\n  message: >-\n    点完下单键弹了认不出的框，停住不盲点：「住所 選択した住所」\n    按钮=[{\"aria\":\"x\"}]\n  exitCode: 1";
  assert.deepEqual(parseOpencliError(folded), { reason: "点完下单键弹了认不出的框，停住不盲点：「住所 選択した住所」 按钮=[{\"aria\":\"x\"}]", code: "COMMAND_EXEC" });
  assert.equal(parseOpencliError("error:\n  message: |\n    line one\n    line two\n  exitCode: 1").reason, "line one\nline two");
  assert.deepEqual(parseOpencliError("some garbage\nlast line", "fb"), { reason: "last line", code: undefined });
  assert.equal(parseOpencliError("", "fallback msg").reason, "fallback msg");
});
