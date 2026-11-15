# 来源约定

## 产品交换范围

MPEG-DASH 采集范围含 MPD/Period/AdaptationSet/Representation 下 BaseURL、SegmentList、SegmentTemplate 的 $Number$ 与 SegmentTimeline(S t/d/r，其中 r>=0)，timescale 与 presentationTimeOffset，ISO 8601 秒/分/小时 duration。动态刷新 minimumUpdatePeriod 仅是可请求时间建议，不是历史覆盖保证。fMP4 只需遍历 box 并提取 emsg v0/v1，不解码音视频。v0 presentation_time_delta 依所载片段在对应 Period 的最早呈现时间，v1 presentation_time 按该事件 timescale 表示绝对 media timeline；再结合 Period 起点和表示时间偏移保留换算依据。身份至少区分节目来源、Period、scheme/value 与 id/呈现位置；重复 bytes 不新增事件，缺片段不宣称无事件。

## 当前来源路由

- `/primary`：application/dash+xml
- `/live`：application/dash+xml
- `/segments/1.m4s`：video/mp4
- `/segments/2.m4s`：video/mp4
- `/segments/p1-1.m4s`：video/mp4
- `/segments/p1-2.m4s`：video/mp4

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://dashif.org/Guidelines-TimingModel/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
