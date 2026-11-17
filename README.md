# stream-events

动态播出清单中的事件资料与片段补采相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

- 静态 MPD：列出显式 SegmentURL 与 EventStream 原声明（`/intakes` 兼容入口保留）。
- 动态 MPD：按 Period 与 SegmentTimeline 跟随领取片段来源，采集 MPD EventStream 与片段内 emsg v0/v1 两类业务事件；只遍历 box，不做音视频转码。
- 每件事件保留来源节目、Period（id/索引/起点）、scheme/value、事件 id、呈现位置、各层 timescale、presentationTimeOffset、原事件载荷（XML 文本或 emsg 原始字节 base64）及换算依据，不覆盖原件数值。
- 刷新语义可解释：清单缩窗、重复发布、迟到片段、清单不可用都按周期留痕；缺失来源登记为“未验证”，不会产生“这段没有事件”的结论；新一轮节目复用 Period id 时按 Period 起点与索引区分，旧 Period 事件不迁移到新时间轴。

`src/reader.mjs` 提供现有单件读取契约；`src/manifest.mjs` 解释动态/静态清单的 Period、BaseURL、SegmentList 与 SegmentTemplate($Number$ + SegmentTimeline S t/d/r)；`src/emsg.mjs` 提取 emsg 并保留时间换算依据；`src/harvest.mjs` 是采集引擎，`applyCycle` 为无 I/O 的纯状态转移；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果和采集状态。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /harvests，JSON 为 {"path":"/live"}（可省略，默认 /live）：执行一轮采集，刷新清单、跟随 Period/片段时间线领取来源并提取事件，返回本轮摘要。清单不可用时周期记为 manifest_unavailable，不推进事件结论；片段领取失败只登记该来源缺口，不中断整轮。
- GET /harvests：按时间顺序列出采集周期（清单摘要、类型、unsupported、片段失败、缩窗依据）。
- GET /events：已观察事件，支持 periodId、scheme、layer 查询参数过滤；每件事件带 Period 归属、timescale/偏移、换算依据和原载荷。
- GET /coverage：逐 Period 说明已声明/已观察/未验证范围、缩窗移出的来源与当前窗口内的缺口。

前四项是兼容接口；新增入口不改变既有语义，所有 GET 请求均为只读，不把 GET 变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整；事件是否“确认不存在”以 /coverage 的未验证清单为准，缺失来源不推断为空。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs。新增 test/timeline.test.mjs 覆盖清单时间线、BaseURL、模板与 emsg 换算；test/harvest.test.mjs 以纯状态转移覆盖缩窗、重复发布、迟到片段、Period 复用与缺失来源语义；test/harvest-integration.test.mjs 经真实 HTTP 来源验证阶段切换、持久化重启与接口只读边界。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t stream-events:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。

## 采集语义要点

- 身份键由来源、Period 键（id+索引+起点）、scheme/value、timescale、事件 id 与呈现位置、载体地址与 box 偏移派生；同一 event id 跨 Period 或跨 scheme 不合并。
- emsg v0 的 presentation_time_delta 结合载体片段的 SegmentTimeline t 与 presentationTimeOffset 换算；缺少 t 时标记不可换算并保留原件，不猜测结果。v1 的 presentation_time 按事件自身 timescale 解释为绝对 media timeline。换算全程 BigInt 有理表示，另给十进制秒。
- 每个 Period 保留全部周期累计的声明来源；被新清单移出窗口的来源进 removedSegmentHrefs，已观察事件与原件不删除。
- 同一来源重复字节不新增事件；内容变化的重发布在 variants 与片段 digest 台账留痕。片段先 404 后补齐时，状态台账记录转换历史。
- 产品不自行调用来源的 /_phase 等联调控制路径；演示脚本在本地样例范围内切换阶段以展示缩窗与迟到片段行为。
