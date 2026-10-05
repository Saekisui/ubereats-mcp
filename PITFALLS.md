# 踩坑记录

这套脚本在真实账号上跑出来的坑。代码里相应的位置都留了注释。按「看到什么症状 → 根因 → 现在怎么做」排列。

---

## 一、价格与「串台」

### 1. 结算页无视 URL 参数，永远显示「活跃车」
- **症状**：review 三辆不同店的车，费用和合计逐项一模一样（麦当劳套餐和一碗意面同价）。
- **根因**：`/jp/checkout?draftOrderUUID=…` 不认这个参数，渲染的是应用内存里的「当前活跃车」。活跃车不存在 cookie / localStorage / sessionStorage 里。早期版本从页面 DOM 读价格，结果店名和商品来自 A 车，价钱和地址来自 B 车。
- **现在**：review 完全不碰页面。费用、合计、商品、地址、ETA 都从 `getCheckoutPresentationV1` 读，它按 draft 查，请求体照抄页面自己切车时发的那份。
- **重要**：光靠「review 的总价 == place 时的总价」这道门挡不住串台。两次读的是同一个错的页面，比对必然通过，门看着锁着其实是开的。所以要加两个独立锚点（`review.js` 的 `reviewSnapshot`）：
  - draft 本体（`getDraftOrderByUuidV2`）的店 uuid 必须等于购物车列表里的店 uuid；
  - 接口回的商品标题必须覆盖购物车列表里的商品。

### 2. 下单绕不开页面，就先把目标车变成活跃车
- 路径：目标店的店页（店 uuid 转成短 id，短 id = uuid 16 字节的 base64url）→ 头部的购物车按钮 → 面板里的「お会計に進む」→ `/jp/checkout`。
- 到了结算页，用接口合计**交叉校验**页面合计，对不上就拒绝下单。

---

## 二、下单那一刻

### 3. 到结算页就弹的凑单框（upsell）
- **症状**：点下单键没反应，原生点击全打在遮罩上。
- **根因**：从「お会計に進む」进结算页时，URL 带 `mod=magicUpsell`，到站就弹「注文の品をすべて揃える」凑单框，里面几十个带 ￥ 的商品按钮和 quick-add。
- **现在**：先识别出凑单框，只点「スキップ」（找不到才点关闭 X），任何带 ￥ 的按钮都不碰。给认出来的按钮打上 `data-ue-target` 标记再点，**不按索引点**，索引一错位就会点成商品。认不出的框直接报错，并带回按钮列表。

### 4. 同一个 testid 有两个看得见的实例
- `place-order-btn` 在结算页有两个（侧栏一个、底部一个）。商品卡片里也常有 2 到 4 个 `<a>`。用 `page.click(selector)` 会报 selector 有歧义。
- **现在**：`nativeClickSelector` 挑第一个有尺寸的元素，滚到视野里，用 CDP 真输入事件按坐标点。

### 5. 两个「地址」：账号的配送位置 cookie 和车的地址
- **症状**：人手点下单不弹框，脚本点就弹「住所情報 / ピンの位置を調整」，要确认楼栋和针位。
- **根因**：Uber 有两个地址概念。draft 的地址按车存；`uev2.loc` cookie 是这台 Chrome 的「当前配送位置」，全局只有一份，改 app 地址簿不会同步过来。两者不一致就会弹框。而框里能点的全是「保存 / 編集 / 削除」，点了就是在写地址簿。
- **现在**：下单前先读 `uev2.loc`，和车的地址比标题和距离（相距 >150m 且标题不同就停），请用户在 Chrome 里把配送位置切好再来。万一还是弹了这种框，也一律不点。

### 6. 弹窗先挂空壳，内容后到
- baseui 的 modal 先渲染外壳，内容晚到。读得太早只看到一个空框，脚本会误判成「认不出的框」。现在会轮询等内容出现。

### 7. 成功判定的假阴性比假阳性危险
- **症状**：单其实下成了，脚本却报 `unknown`。点完最终确认后立刻读 `getActiveOrdersV1` 还是 0，页面又被弹回店页（其实是下单成功后的正常跳转）。
- **为什么危险**：报「没下成」，人就会重按，于是真的重复下单、重复扣钱。
- **现在**：轮询活动订单，锚点是**订单 uuid == draft uuid**（实测 Uber 的订单 uuid 就是 draft uuid）。MCP 层规定：`unknown` 或过了闸之后的任何报错，都先 `ue_orders` 查，绝不重按。

### 8. dry-run 的那行 return 别动
- 有一次重排代码时，「读页面 → 交叉校验 → dry-run 在此返回」整块丢了，一次 `--dry-run` 真的点了第一步键。好在后面认不出弹窗就停住了，没下成。那行现在加了注释。

### 9. 其他明确拒绝的框
- 「営業時間外 / 配達時間を指定 / 予約」：店打烊、要求预约，脚本不替人预约。
- 「店舗を利用できません / ご注文を受け付けていません」：店家现在不接单。

### 10. opencli 默认 60 秒超时
- adapter 命令默认只有 60 秒（`OPENCLI_BROWSER_COMMAND_TIMEOUT`）。正常下一单光固定等待就 30 到 45 秒，如果超时正好发生在「已按最终确认、正在轮询订单」那一段，就是单下成了却报超时。
- opencli 只有在 adapter **声明了名为 `timeout` 的参数**时才认 `--timeout`。`place.js` 声明了，默认 150 秒，opencli 会再加 30 秒缓冲。MCP 那边调用 place 时的超时也要跟着放宽，否则会先被掐断。

---

## 三、加购

### 11. 加购后商品框会停留一会儿
- 点完加购键，商品框不一定马上关。如果之后的弹窗处理逻辑看到加购键还亮着、又按一下，就会加成两份。
- **现在**：只在快捷加购那条路上补按加购键（应对详情框晚到）；走模态框那条路时，加购键已经按过了，不再补按。

### 12. 数量设不上要停
- 模态框里没找到数量下拉框时，以前会悄悄只加 1 份，还报成功。现在 qty>1 却设不上，就直接报错、不加购。

---

## 四、超市 / 便利店 / 药店

### 13. 商品卡长得和餐厅不一样
- 餐厅：`li[data-testid="store-item-<uuid>"]`，文字是品名在前、价格在后。
- 超市：`div[data-testid="store-item-<uuid>"]`，**链接包在外层的 `<a>` 上**；文字是**价格在前**，打折时还有两个价格，比如「10% オフ ￥161 ￥179 アクエリアス(950ml)」，品名要取最后一个价格后面的部分。
- 首页只放几排推荐（「ベストセラー」之类），完整货架在别处。

### 14. 店内搜索
- 地址格式：**真实店名路径** + `/<店uuid>?diningMode=DELIVERY&storeSearchQuery=<词>`。
- `/jp/store/s/<短id>` 这种短地址会重定向，并把 query 参数丢掉。
- opencli 的 `page.getCurrentUrl()` 返回的是上一次 `goto` 的地址缓存，不是重定向后的真实地址。要拿真实路径，得在页面里读 `location.pathname`。
- 背后调用的接口是 `getInStoreSearchV1`，按相关度返回，所以不要再按字面过滤：搜「風邪薬」返回的是各种药名。

### 15. 超市商品要用深链打开
- 超市商品多半不在首页，没法像餐厅那样在页面上找到再点。可以用 quickView 深链直接打开商品框：`?mod=quickView&modctx=<两次 encodeURIComponent 的 JSON>`，JSON 里要有 `storeUuid / sectionUuid / subsectionUuid / itemUuid` **四个** uuid，少一个都打不开。
- 所以超市商品的 id 写成 `store:item:section:subsection`（133 个字符）。MCP 输出时 id 不能被截断。

### 16. 全站按商品名搜，回的是另一种卡片
- 按商品名搜（如「ポカリスエット」），`getSearchFeedV1` 回的是 `MINI_STORE_WITH_ITEMS`：`miniStoreWithItems.store` 是店，`miniStoreWithItems.items` 是命中的商品（带 sectionUuid / subsectionUuid）。只读 `feedItem.store` 的话会全部丢掉。

---

## 五、登录与风控

### 17. 读不到登录状态 ≠ 没登录
- 页面还在跳转、请求被打断时，`/bootstrap.json` 会读失败。以前把这种情况当成「没登录」，叫人去重新登录，其实一直登着。现在会先重试一次，还不行就报真实错误。
- `AuthRequiredError` 的签名是 `(domain, message)`。只传一个参数的话，整句话会被当成 domain，报错就变成「Not logged in to Not logged in to …」。

### 18. reCAPTCHA 风控
- 请求太密时（比如短时间内反复跳页、批量调接口），`/_p/api/*` 会回 **403**，body 是 `{"status":"failure","metadata":{"botdefense":{"state":"challenge","provider":"RECAPTCHA"}}}`，而 `bootstrap.json` 照样显示已登录。
- 目前的代码会把它报成 AUTH_REQUIRED（session 过期），容易误导。处理办法是：请人去 Chrome 里打开 ubereats.com 手动操作一下、过了验证再来。**不要用脚本去碰验证码。**

---

## 六、零碎

- opencli 失败时的输出是 yaml，多行 message 会写成折叠块（`>-` / `|`），只抓 `message:` 那一行会把正文吞成 `>-`。`core.js` 的 `parseOpencliError` 会把后面缩进的行一起收进来。
- `--keep-tab` 必须带值（`--keep-tab true`），不然会把后面的 `--format` 吞掉。下单时要留着标签页：提交请求还在路上时关窗有风险，失败现场也要留着看。
- JS 模板字符串里塞给 `page.evaluate` 的正则，`\s` `\d` 要写成 `\\s` `\\d`，否则会被模板字符串吞掉。
- 删整辆车的接口是 `discardDraftOrdersV1`，请求体 `{ "draftOrderUUIDs": [...] }`，测试完清理用得上。
- 浏览器类命令共用同一个 Chrome，**串行跑，别并发**。
