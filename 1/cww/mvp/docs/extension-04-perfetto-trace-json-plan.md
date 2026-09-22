# 扩展案例 4A：Chrome Trace JSON 与 Perfetto 方案

> 状态：主机侧构建已通过，待实机串口和 Perfetto 验证
>
> 适用范围：`extensions/04_live_infer_trace`
>
> 课程边界：微课 04 不介绍火焰图；本方案只在扩展案例 4A 中引入。

## 1. 目标

在不引入 ESP-IDF Function Tracing、SystemView、JTAG 或额外主机转换器的情况下，让学生获得一份可以用 Perfetto 打开的性能时间线。

设备端通过串口打印 Chrome Trace JSON，开发者手动复制 JSON 内容到文件，再使用 Perfetto UI 查看预览、取帧、推理和后处理阶段的时间关系。

第一版的教学产出是“阶段级性能时间线（火焰图式示意）”，不是 ESP-DL 内部函数级 profiler，也不是传统采样型火焰图。

## 2. 技术路径

```text
ESP32 记录阶段开始时间和持续时间
        ↓
RAM/PSRAM 暂存少量 trace 事件
        ↓
串口输出一段合法的 Chrome Trace JSON
        ↓
开发者复制 JSON 到 trace.json
        ↓
python -m json.tool 校验
        ↓
Perfetto UI 打开并查看时间线
```

Perfetto 支持 Chrome JSON 格式以及 Perfetto 原生 protobuf 格式。对于本课程，Chrome JSON 更容易由 ESP32 直接生成，也更容易让学生理解。[Perfetto 支持的外部 trace 格式](https://perfetto.dev/docs/getting-started/other-formats)

## 3. 方案边界

- 新建扩展案例 4A；微课 04 和已有 `extensions/04_live_infer_optimized` 不增加火焰图内容。
- 不要求设备直接保存 JSON 文件；第一版只通过串口打印。
- 不使用现有的 `infer`、`period`、`frame_age` 等普通日志直接生成 trace。它们缺少嵌套事件和阶段持续时间。
- 新增一个显式 trace 输出模式，例如编译宏 `PERFETTO_TRACE_JSON`；采集期间暂停普通日志，避免非 JSON 内容混入文件。
- 只记录课程自有代码和 ESP-DL 分类接口能够稳定划分的阶段：`preview_window`、`frame_peek`、`input_prepare`、`infer`、`classifier_task`、`preprocess`、`model_infer` 和 `postprocess`。
- `g_classifier->run()` 作为完整的 `infer` 外层事件记录；Trace 模式在课程自有的 `CatDogClassifier::run()` 中调用 ESP-DL 已公开的 `preprocess()`、`Model::run()` 和 `postprocess()`，分别记录三个阶段。
- 不插桩 ESP-DL、摄像头驱动、FreeRTOS 或其他第三方代码。
- 第一版不新增 `esp_sysview` 依赖，不要求 JTAG，不要求 `idf.py menuconfig`。trace 模式通过 `idf.py -DPERFETTO_TRACE_JSON=1 build` 启用，普通构建默认关闭。

## 4. 设备端事件设计

使用 Chrome Trace 的完整事件 `ph: "X"`。每条事件包含：

| 字段 | 含义 |
|---|---|
| `name` | 阶段名称，例如 `infer`、`input_prepare` |
| `cat` | 分类，例如 `vision`、`preview` |
| `ph` | 完整事件，固定为 `X` |
| `ts` | 开始时间，单位为微秒 |
| `dur` | 持续时间，单位为微秒 |
| `pid` | 设备或应用标识，课程中可固定为 `1` |
| `tid` | 时间线标识，用于区分预览任务、推理任务或 CPU |
| `args.core` | 实际运行 CPU，便于观察 CPU0/CPU1 隔离 |

建议使用 `esp_timer_get_time()` 获取相对时间。每次推理只记录少量阶段事件，不对每个函数调用 `ESP_LOGI()`。当前实现达到 3 次推理后自动停止推理任务并打印 trace。

示例事件：

```json
{
  "name": "infer",
  "cat": "vision",
  "ph": "X",
  "ts": 101500,
  "dur": 320000,
  "pid": 1,
  "tid": 11,
  "args": {
    "core": 1
  }
}
```

如果 `g_classifier->run()` 没有暴露更细粒度的内部阶段，就把它作为整体 `infer` 事件；不能据此声称已经分析了 ESP-DL 内部函数。

## 5. 串口输出与人工复制

采集窗口输出以下内容。两个标记只用于帮助开发者定位复制范围，不属于 JSON 文件本身：

```text
TRACE_JSON_BEGIN
{"traceEvents":[
{"name":"preview_window","cat":"preview","ph":"X","ts":100000,"dur":1500000,"pid":1,"tid":10,"args":{"core":0}},
{"name":"infer","cat":"vision","ph":"X","ts":101500,"dur":320000,"pid":1,"tid":11,"args":{"core":1}}
]}
TRACE_JSON_END
```

开发者操作步骤：

1. 构建并运行 trace 输出模式；
2. 从串口日志中找到 `TRACE_JSON_BEGIN` 和 `TRACE_JSON_END`；
3. 只复制两个标记之间的内容，从 `{` 开始到 `}` 结束；
4. 保存为 `trace.json`；
5. 执行 `python -m json.tool trace.json` 检查格式；
6. 打开 [Perfetto UI](https://ui.perfetto.dev/) 并载入 `trace.json`；
7. 保存 Perfetto 截图，并与普通性能日志中的 FPS、`infer` 和 `frame_age` 对照。

JSON 输出期间不得混入普通 `ESP_LOGI`、启动信息或其他非 JSON 文本。设备端应先把事件放入 RAM/PSRAM 缓冲区，在固定测试窗口结束后一次性打印，以减少串口输出对被测性能的干扰。

## 6. 代码与文件计划

```text
extensions/04_live_infer_trace/
├── main/trace_json.hpp       # 追踪事件结构和输出接口
├── main/trace_json.cpp       # RAM 缓冲、时间戳和 JSON 序列化
├── main/app_main.cpp         # 在课程自有阶段增加追踪点
├── sdkconfig.defaults        # 如有需要，保留显式 trace 开关
└── README.md                 # 构建、复制、校验和 Perfetto 操作说明
```

建议先记录一个固定测试窗口内的 3～5 个推理周期，同时保留预览任务和推理任务的不同 `tid`；本工程默认复现微课的 CPU0/160 MHz 卡顿基线。trace 模式与普通模式必须分别构建或分别运行，不能把 trace 模式的结果直接当作无开销基线。

## 7. Perfetto 中的观察任务

学生至少应完成以下观察：

- 找到 CPU0 上的预览时间片；
- 找到 CPU1 上的推理时间片；
- 比较 `preview_window`、`frame_peek`、`input_prepare`、`infer`、`preprocess`、`model_infer`、`postprocess` 和 `classifier_task` 的持续时间；
- 判断最长的阶段是否与普通日志中的 `infer` 结果一致；
- 观察推理阶段是否影响预览任务的时间线；
- 解释为什么 trace 输出本身可能改变 FPS、`infer` 和 `frame_age`。

Perfetto 直接显示的是可缩放时间线和嵌套时间片。它可以作为本案例的可视化工具，但不应在文档中表述为“Perfetto 自动生成了传统 SVG 火焰图”。

## 8. 验收条件

- [ ] trace 模式能够输出一段独立的 JSON 文档；
- [ ] JSON 文档只包含 `traceEvents`，没有混入普通日志；
- [ ] 复制后的 `trace.json` 能通过 `python -m json.tool` 检查；
- [ ] `trace.json` 能在 Perfetto UI 中打开；
- [ ] Perfetto 至少显示两个阶段时间片；
- [ ] 时间片能够区分预览任务和推理任务，或区分 CPU0 与 CPU1；
- [ ] 学生能够指出耗时最长的阶段，并与 `infer` 日志相互印证；
- [ ] README 明确说明这是阶段级性能时间线，不是 ESP-DL 内部函数级火焰图；
- [ ] trace 模式与普通模式的数据分开记录，并注明采集配置和追踪开销。

## 9. 后续升级路线

如果后续需要经典 SVG 火焰图，可从同一份结构化事件增加主机端聚合脚本；如果需要任意函数级调用信息，再评估 ESP-IDF Function Tracing 和 SystemView。两者不属于本方案的前置依赖。
