# ubereats-jp-mcp

![让 AI 帮你点外卖](assets/cover.png)

**介绍页：<https://saekisui.github.io/ubereats-jp-mcp/>**

让 AI 在**你自己的 Chrome** 里帮你点 Uber Eats（有 Uber Eats 的国家都能用，日本站实测最多）：搜店 / 搜商品、看菜单、加购、看结算快照，**你点头之后**才下单，下单后跟配送。

一个 MCP server + 一套 [OpenCLI](https://github.com/jackwener/opencli) adapter。AI 用的是你 Chrome 里的真实登录态，地址和支付方式只用账号里已经存好的，对话里从不出现卡号或地址。

> 非官方项目，与 Uber 无关。只在你自己的账号上、花你自己的钱。

---

## 它做什么，不做什么

**做**
- 搜店、搜菜、搜商品。按商品名搜（ポカリスエット、風邪薬…）会返回超市 / 药店，并附上命中的商品和价格
- 看菜单：餐厅照常；超市 / 便利店 / 药店的首页只放几排推荐，可以用 `query` 走店内搜索
- 加购：支持选项（多级选项逐级匹配，例如 套餐 → ドリンクM → コカ・コーラ）和数量
- 结算快照：店名、商品、各项费用、合计、ETA、配送地址、支付方式
- 下单：只能在 review 之后、拿着 confirm_token 下
- 查进行中订单的配送进度

**不做**
- 不碰支付密码、卡号、地址簿（弹出要编辑地址的框会直接停住）
- 不过人机验证，不替你预约配送时间
- 不会自己下单。必须走 `ue_review` → 你在对话里明确同意 → `ue_place`

---

## 安全设计

| 关卡 | 做法 |
|---|---|
| 价格从哪来 | 只信 `ue_review`：按 draft 查 Uber 的结算接口（`getCheckoutPresentationV1`），**不读页面**。结算页无视 URL 参数，永远显示「当前活跃的那辆车」，读页面会把 A 店的商品配上 B 店的价钱 |
| 防串台 | 两个独立锚点：draft 本体的店 uuid 必须等于购物车列表里的店；接口回的商品必须覆盖购物车里的商品。任一不符直接报错，绝不返回混合了两辆车的快照 |
| confirm_token | review 时发，10 分钟有效，只能用一次，绑定 draft。place 前再读一次快照，总价 / 店名 / 购物车变了就拒绝 |
| 上限 | `policy.json`：**默认关着**。单笔上限、当日上限（账号所在国家的币种），这个文件只该由你本人改 |
| 下单那一刻 | 页面合计必须等于接口合计才点；凑单弹窗只点「スキップ」，里面任何带 ￥ 的商品按钮都不碰；认不出的弹窗一律停下，并把按钮列表带回来 |
| 状态不明 | 返回 `unknown` 或报错**不等于没下成**，先用 `ue_orders` 查，绝不重按。重按就是第二单、第二笔钱 |

---

## 国家和界面语言

Uber Eats 网址里的 `/jp` 管的是**界面语言**，不是国家：显示哪些店、用什么币种，跟着你账号的配送地址走。所以这套东西不分国家，只分界面语言：

| `UE_LOCALE` | 界面 | 状态 |
|---|---|---|
| `en`（默认） | 英文 | 读的部分（搜店 / 菜单 / 购物车 / 结算快照）按同一套接口走；**下单这一步还没人在英文界面上真跑过** |
| `jp` | 日文 | 实测最多：十几单真单，凑单弹窗、地址确认框、假阴性这些坑都踩过 |

价格不认币种（¥ / $ / NT$ / HK$ / £ / € 都能读，`12,34` 这种逗号小数也认），「当天」按 `policy.json` 的 `timezone`（不写就是电脑的时区）算。

**在日本以外的地方第一次用，请这样走一遍：**
1. 只读命令都跑一下：`whoami` / `search` / `store` / `cart` / `review`
2. `opencli ubereats place --draft <draft_id> --dry-run`：会走到结算页、做完所有校验就停，不下单
3. 第一单真下的时候，人在旁边看着。脚本认不出的弹窗会停下，并把弹窗里的按钮列表带回来——把那段报错发个 issue，就能把这个国家的流程补上

## 准备

1. **Node 20+**，以及 OpenCLI（在 1.8.6 上测过）：
   ```bash
   npm i -g @jackwener/opencli
   ```
2. 按 OpenCLI 的说明装好 Chrome 的 Browser Bridge 扩展，确认 `opencli doctor` 通过。
3. 在这个 Chrome 里登录 **ubereats.com**，设好配送地址。
4. 拿到本仓库，把 adapter 同步到 OpenCLI（OpenCLI 不认软链目录，必须复制过去；以后改了 adapter 也要再跑一次）：
   ```bash
   git clone <本仓库地址> && cd ubereats-jp-mcp
   npm run sync
   ```
5. 先用命令行试一下，都是只读的：
   ```bash
   opencli ubereats whoami
   opencli ubereats search ramen --limit 5
   ```
   想用日文界面就在命令前加 `UE_LOCALE=jp `。
6. 想让 AI 能下单的话，编辑 `policy.json`，把 `"enabled"` 改成 `true`，按自己的情况调上限（账号币种），需要的话写上 `"timezone"`（如 `"America/New_York"`）。不改就只能搜、看、加购，不能下单。
7. 注册 MCP。以 Claude Code 为例：
   ```bash
   claude mcp add ubereats-jp -- node /绝对路径/ubereats-jp-mcp/mcp/server.js
   ```
   要日文界面就加 `-e UE_LOCALE=jp`；如果 opencli 不在 `~/.npm-global/bin/opencli`，再加 `-e OPENCLI_BIN=/path/to/opencli`。

---

## 一单怎么走

```
你：「帮我点份拉面」
AI：ue_search → ue_store（看菜单）→ ue_add（选好规格）→ ue_cart
AI：ue_review → 把快照原样给你看（店 / 品 / 费用 / 合计 / 地址 / 支付）
你：「好」
AI：ue_place → ue_orders（确认下成、之后跟配送）
```

| 工具 | 读 / 写 |
|---|---|
| `ue_policy` | 读：开关、上限、今天已花多少、登录状态 |
| `ue_search` | 读 |
| `ue_store` | 读（`query` 走超市店内搜索） |
| `ue_add` | **写**：加购物车 |
| `ue_cart` | 读：每家店一辆车，给出 draft_id |
| `ue_review` | 读：结算快照 + confirm_token |
| `ue_place` | **写·花钱** |
| `ue_orders` | 读 |

每次调用都会记一行到本地的 `ledger.jsonl`（已 gitignore），当日上限按它来算。

### 不经过 MCP，直接用命令行

```bash
opencli ubereats store <店id> --query ポカリ
opencli ubereats add <商品id> --spec "コーラ ポテト(L)" --qty 1
opencli ubereats cart
opencli ubereats review --draft <draft_id>
opencli ubereats place --draft <draft_id> --dry-run   # 走到结算页、做完校验就停，不点下单
opencli ubereats orders
```

---

## 已知限制

- 日本 + 日文界面实测最多；英文界面的下单步骤、其他国家的结算流程（比如美国的小费）还没人真跑过，认不出就会停下。Uber 的页面和接口随时会变，坏了先看 [PITFALLS.md](./PITFALLS.md)。
- **请求别太密。** Uber 有 reCAPTCHA 风控：请求太频繁时，接口会回 403（`botdefense: challenge`）。这时去 Chrome 里打开 ubereats.com 手动搜一下、过了验证再用；脚本不会、也不该去碰验证码。浏览器命令请串行跑，别并发。
- 第一次真下单，请人在旁边看着。
- 药品之类可能弹问诊或确认框，脚本认不出就会停下，需要你自己在 app 里完成。

## License

MIT
