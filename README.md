# stream-events

动态播出清单中的事件资料与片段补采相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

- 静态 MPD：列出显式 SegmentURL 与 EventStream 原声明。
- 动态 MPD：跟随 Period 与片段时间线（SegmentTemplate `$Number$` + SegmentTimeline `S t/d/r`、SegmentList、BaseURL），逐轮领取清单与片段，解释 MPD EventStream 与 fMP4 内 emsg v0/v1。
- 各层 timescale、presentationTimeOffset、Period 起点与原事件载荷（emsg 消息字节按 base64 原样留存）均不丢失；时间换算以 BigInt 有理数保存并记录所用规则，不做音视频转码。
- 事件身份区分节目来源、Period、scheme/value、id 与呈现位置；同一 event id 在不同 Period 或方案下分别登记。
- 清单缩窗、重复发布、迟到片段与条件复核（ETag/304）都能解释已观察范围：缺来源只标记 `expected/unavailable/withheld`，绝不宣称“这段没有事件”；已确认零事件必须是真正领取并解析后的 `fetched` 结论。旧 Period 的事件保留在原 Period 锚点上，不迁移到新节目时间轴；Period id 复用且起点变化时显式标记锚点冲突。

`src/reader.mjs` 提供单件读取与 emsg 提取契约；`src/manifest.mjs` 展开采集计划；`src/timeline.mjs` 负责事件时间轴解释与身份键；`src/iso.mjs` 是 ISO 8601 时长与时间线纯函数；`src/harbor.mjs`/`src/harbor-store.mjs` 是动态采集引擎与持久状态；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存通用收件原件。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

这四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

## 动态采集接口（EventHarbor）

- POST /harbor/intakes，JSON 为 {"path":"/live"}：执行一次跟随采集（条件复核 MPD → 同步 Period/片段声明 → 补领未成功来源）。领取失败返回 422 并在观察记录中留痕，不产生任何“无事件”结论。
- GET /harbor/state：完整持久状态（来源、观察、Period 锚点、片段覆盖、事件）。
- GET /harbor/events：已确认观察到的事件（EventStream 与 emsg），含原字段、原载荷、换算锚点与身份键。
- GET /harbor/coverage：每个清单声明过的片段来源及其状态（`expected`/`unavailable`/`fetched`/`unparseable`，以及 `withheld`/`outOfWindow` 窗口标记和历次 attempts）。
- GET /harbor/observations：历次 MPD 观察（`manifest`/`manifest-not-modified`/`manifest-fetch-error`），含摘要、ETag 与 `repeatedBytes`。

Harbor 状态独立存于 DATA_DIR/harbor/harbor.json，与通用收件 index.json 隔离；所有写入串行并原子替换，重启后观察范围与事件完整保留。需要自动跟随时以 `HARBOR_PATH=/live HARBOR_POLL_MS=2000` 启动，轮询间隔由运维显式给出（minimumUpdatePeriod 只是可请求建议，不是历史覆盖保证）。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，动态采集的时间线解释在 test/harbor-domain.test.mjs，缩窗/重复发布/迟到片段/持久重开/Period 身份等生命周期在 test/harbor-lifecycle.test.mjs，HTTP 入口在 test/harbor-http.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t stream-events:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
