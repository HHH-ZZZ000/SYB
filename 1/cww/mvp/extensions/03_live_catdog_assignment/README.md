# 最小案例 3 阶段性作业：LCD 实时猫狗分类

> 类型：`ASSIGNMENT` ｜ 验证状态：参考值，待实机校准 ｜ 前置：[`extensions/03_catdog_static_infer`](../03_catdog_static_infer/)

## 摘要

本作业把最小案例 2 量化出的猫狗模型接入 ESP32-S3-EYE 的摄像头和 LCD 预览管线：LCD 显示实时画面，推理任务每 500 ms 读取最新预览帧做一次分类，串口持续打印"第几次推理、Top-1 类别、置信度、耗时"。你要同时提交画面、分类结果和性能证据。和最小案例 3 微课"对 SD 卡静态图片分类"不同，本作业的分类对象是**摄像头正在拍到的实时画面**；模型嵌入 flash rodata，不读 SD 卡。它是最小案例 4 性能实验的基线工程，不是完整 Memory Pendant 闭环。

## Quick Start

**预备知识**

- **FreeRTOS 任务**：带优先级的循环函数，数字越大越先跑。本工程有四个任务：`FrameCapFetch`（摄像头取帧，优先级 2，钉 CPU0）、`LCDDisp`（LCD 显示，优先级 2，钉 CPU0）、`classifier_task`（推理，优先级 3，**不绑核**）、`Yield2Idle`（防饿死监控，最高档）。
- **双核**：ESP32-S3 有 CPU0/CPU1。推理优先级高于预览又不绑核，跑起来的约 3 秒里同核预览任务只能干等——这就是你要观察的"卡顿"来源，也是最小案例 4 实验的起点。
- **帧缓冲与环形缓冲**：摄像头输出 240×240 RGB565 帧（每帧约 112 KB），3 块帧缓冲（`kCameraFbCount = 3`）放在 PSRAM 轮转使用；取帧节点内部维护长度 1 的环形缓冲，永远只保存最新一帧。
- **peek**：`cam_fb_peek()` 只"看一眼"最新帧的指针，不取走、不复制、不排队。LCD 和推理都靠它读同一份最新帧，推理永远不会积压旧帧。
- **模型从哪来**：最小案例 2 量化输出的 `catdog_mobilenet_v2.espdl`，构建时用 `EMBED_FILES` 嵌进固件只读数据区（flash rodata），上电即跑；分区表给应用留了约 7 MB。
- **置信度**：后处理对 2 个输出分数做 softmax，得到加起来为 1 的概率。置信度高不等于一定对——遮挡或画面里没有猫狗时模型也会强行二选一，如实记录。
- **FPS 与推理频率是两回事**：预览每秒十几到二十帧，推理约每 3～4 秒才出一次结果。**推理序号不是摄像头帧号**，中间的帧都被环形缓冲覆盖了，详见 [`frame_audit.md`](frame_audit.md)。


**第 0 步：前置条件**

- ESP-IDF ≥ 5.4（`main/idf_component.yml` 要求 `idf: ">=5.4"`，托管组件 `esp-dl ^3.3.0`、`esp32_s3_eye ^6.0.0`）；
- 已完成最小案例 2 量化，并把输出的 `.espdl` 放到本目录 `main/models/s3/catdog_mobilenet_v2.espdl`；缺失时构建直接报 `Missing model file`。

**第 1 步：进入目录、设置目标芯片**

```bash
cd extensions/03_live_catdog_assignment
idf.py --version          # 预期输出 ESP-IDF v5.4.x 之类的版本号
idf.py set-target esp32s3 # 首次会联网拉取 esp-dl 等依赖，约 2～5 分钟
```

`set-target` 按 `sdkconfig.defaults` 生成 `sdkconfig`：8 MB flash、自定义分区、八线 PSRAM @80 MHz、LCD 绘制缓冲 40 行；CPU 频率未显式指定，用 IDF 默认值（当前生成的 `sdkconfig` 中为 160 MHz）。

**第 2 步：编译**

```bash
idf.py build
```

预期 `Project build complete`，首次约 5～15 分钟。构建系统会把 `.espdl` 复制到 `build/` 并嵌入固件（生成物不要手工编辑）。

**第 3 步：烧录 + 串口监视器（有开发板时）**

```bash
idf.py -p <PORT> flash monitor
```

`<PORT>` 换成实际串口设备名（macOS 是以 cu 开头的设备，Linux 形如 `/dev/ttyACM0`）。预期：LCD 出现实时画面，串口打印 `Loading cat/dog classifier from flash rodata` → `Classifier loaded successfully` → `System ready — camera preview + periodic inference running`，之后约每 3～4 秒一行分类结果。退出监视器按 `Ctrl+]`。

**第 4 步：验证分类功能**

把猫/狗（实物、照片或屏幕图）放到镜头前，观察类别切换、置信度和耗时。用手遮住镜头，记录模型输出——遮挡时输出低置信度的乱猜是正常现象，如实记录。

**第 5 步：采集作业证据**

按 [`frame_audit.md`](frame_audit.md) 补充审计：连续抄录若干行递增序号的日志（Top-1、置信度、耗时）；说明帧缓冲的 peek/归还责任；重复启动停止后检查可用 PSRAM 和稳定性。注意 `[%lu]` 打印的是**推理序号**（`s_frame_count`），不是摄像头帧号；要拿真实帧号需按拓展挑战自行加日志。

模型由构建系统嵌入，不需要 SD 卡。没有开发板时只能提交构建证据，不能把帧率、分类准确率或内存稳定性写成已实测。

## 预期现象

成功时 LCD 持续显示画面，串口出现类似：

```text
[1] cat: 0.7312 (推理耗时 ... us / ... ms)
[2] dog: 0.6841 (推理耗时 ... us / ... ms)
```

字段对照（`main/app_main.cpp`，TAG 为 `camera_catdog_live`）：

| 字段 | 来源 | 含义 |
|---|---|---|
| `[1]` | `s_frame_count` | 推理序号（第几次推理），**不是**摄像头帧号 |
| `cat` / `dog` | `results[0].cat_name` | Top-1 类别，标签来自 [`main/labels.hpp`](main/labels.hpp) 的 `{"cat", "dog"}` |
| `0.7312` | `results[0].score` | softmax 后的 Top-1 置信度 |
| `推理耗时 ... us / ... ms` | `esp_timer_get_time()` 差值 | 单次 `run()` 耗时，同一数字的两种单位 |

失败路径日志必须原样保留：模型输入/输出为空时打印 `Model loaded but inputs/outputs are empty` 且随后 `Failed to initialize classifier`；管线启动失败时打印 `Failed to start camera capture / LCD tasks`；结果为空时该行日志不打印。采集帧数、真实丢帧数和缓冲区归还证据按 [`frame_audit.md`](frame_audit.md) 另行审计。

**常见问题排查**

| # | 现象 | 原因 | 解决 |
|---|---|---|---|
| 1 | 构建报 `Missing model file` | 模型文件没放到位 | 从 `extensions/02_quantize_catdog_model/outputs/` 复制 `.espdl` 到 `main/models/s3/` |
| 2 | `Model loaded but inputs/outputs are empty` | `.espdl` 损坏、为空或与 esp-dl ^3.3.0 不兼容 | 重新执行最小案例 2 量化，复制时比对文件大小 |
| 3 | LCD 黑屏但串口有分类日志 | 显示任务未启动或背光异常 | 看有无 `Failed to start camera capture / LCD tasks`，确认 `CONFIG_BSP_LCD_DRAW_BUF_HEIGHT=40` 未改，重新烧录 |
| 4 | 一直没有分类日志，画面正常 | peek 拿不到帧或结果为空 | 看有无 `Unable to peek from an empty frame buffer.` 告警；持续无帧则检查摄像头排线和 `CONFIG_SPIRAM_MODE_OCT=y` |
| 5 | 启动即重启 / `Guru Meditation Error` | `sdkconfig` 与板子不匹配或分区表被改 | `rm sdkconfig && idf.py set-target esp32s3 && idf.py build`，确认 `partitions.csv` 未改 |
| 6 | 运行几分钟后 `task watchdog` 告警或复位 | 某核长期无空闲 | 保留完整日志作为审计证据，按 Kconfig 帮助检查 `CONFIG_ESP_TASK_WDT_TIMEOUT_S` |

## 学习目标

- 构建并运行 LCD 摄像头预览与周期性推理；
- 解释最新帧 `peek` 策略与推理任务的关系；
- 记录推理序号、Top-1、置信度和耗时；
- 分析采集、推理、丢帧/积压和缓冲区稳定性证据。

## 原理讲解

摄像头和 LCD 管线持续工作，`classifier_task` 周期性 `cam_fb_peek()` 拿最新帧跑一次分类，模型从 flash rodata 加载。用一个类比串起来：摄像头是**不断拍照的摄影师**（拍完新片覆盖旧片，桌上只留最新一张）；LCD 是**相框**，一看到换片就展示；推理任务是**每半分钟来一次的鉴定师**，只看桌上当前那一张（peek），鉴定约 3 秒。如果给推理建先进先出队列，3 秒一次的消费速度远跟不上每秒十几帧的生产速度，队列会无限积压、结果越来越旧；peek"只看最新、不问历史"，保证新鲜度和内存恒定，代价是绝大多数帧从未被推理——所以要按 [`frame_audit.md`](frame_audit.md) 另行审计采集帧数与推理次数的关系。

![实时视觉任务布局对比图（AI 生成示意）](../../docs/assets/ai_generated/cpu_task_layout_baseline_optimized.png)

> 图：左侧基线与右侧优化布局用于引出最小案例 4 的性能实验，实际任务绑定以固件为准。

## 整体流程图

```text
摄像头 → WhoFetchNode → 最新帧
          ├─ LCD 显示
          └─ classifier_task（500 ms）→ CatDogClassifier
                                      ↓
                          序号 / 类别 / 置信度 / 耗时
```

组件对应：`WhoS3Cam`（摄像头驱动，RGB565/3 缓冲/PSRAM/只留最新帧）→ `WhoFetchNode`（取帧 + 长度 1 环形缓冲 + 新帧事件广播）→ `WhoFrameLCDDisp`（订阅新帧事件，LVGL 显示）与 `classifier_task` 并行消费同一份最新帧。

## 关键代码解析

**1. 推理任务：[`classifier_task`](main/app_main.cpp)（节选）**

```cpp
// 任务创建：xTaskCreate(..., 8192, nullptr, 3, nullptr)——优先级 3、栈 8 KB、不绑核
while (true) {
    auto fb = (g_frame_node && g_classifier) ? g_frame_node->cam_fb_peek() : nullptr;
    if (fb) {
        int64_t start = esp_timer_get_time();                        // 微秒计时开始
        dl::image::img_t img = static_cast<dl::image::img_t>(*fb);   // 零拷贝视图转换
        auto &results = g_classifier->run(img);                      // 预处理+推理+后处理
        int64_t elapsed = esp_timer_get_time() - start;
        s_frame_count++;                                             // 推理序号自增（不是帧号！）
        if (!results.empty())
            ESP_LOGI(TAG, "[%lu] %s: %.4f (推理耗时 %lld us / %.3f ms)",
                     s_frame_count, results[0].cat_name, results[0].score, elapsed, elapsed / 1000.0f);
    }
    vTaskDelay(kInferIntervalTicks);                                 // 每轮睡 500ms，让出 CPU
}
```

最小案例 4 微课会把它改成 `xTaskCreatePinnedToCore` 做绑核实验。分类封装 [`CatDogClassifier`](main/catdog_classifier.hpp) 从 flash rodata 加载模型，输入/输出为空时报错并保持 `m_ready=false`，调用方必须检查 `is_ready()`。

**2. 帧管线与 3 缓冲：[`get_preview_frame_cap_pipeline`](main/frame_cap_pipeline.cpp)**

```cpp
static constexpr uint8_t kCameraFbCount = 3;   // 摄像头驱动持有的帧缓冲数量

WhoFrameCap *get_preview_frame_cap_pipeline()
{
    framesize_t frame_size = get_cam_frame_size_from_lcd_resolution(); // LCD 240×240 → 选 240×240 帧
    // 嵌入式 ESPDL 模型占用大量 PSRAM，因此只保留预览+推理所需的最少帧缓冲
    auto cam = new WhoS3Cam(PIXFORMAT_RGB565, frame_size, kCameraFbCount);
    auto frame_cap = new WhoFrameCap();
    frame_cap->add_node<WhoFetchNode>("FrameCapFetch", cam); // 环形缓冲长度 = fb_count-2 = 1
    return frame_cap;
}
```

`WhoS3Cam` 构造时配置帧缓冲放 PSRAM、只留最新帧的 `CAMERA_GRAB_LATEST` 抓取模式和默认水平镜像。

**3. peek 的实现：`components/who_frame_cap/who_frame_cap_node.cpp`**

```cpp
cam_fb_t *WhoFrameCapNode::cam_fb_peek(int index)
{
    xSemaphoreTake(m_mutex, portMAX_DELAY);        // 互斥锁：防止读到正在被替换的帧指针
    if (m_cam_fbs.empty()) {                        // 缓冲里还没有帧 → 返回空并告警
        ESP_LOGW(TAG, "%s: Unable to peek from an empty frame buffer.", get_name().c_str());
        xSemaphoreGive(m_mutex);
        return nullptr;
    }
    if (index == -1) index = m_cam_fbs.size() - 1;  // 默认取最新一帧
    cam_fb_t *ret = m_cam_fbs[index];
    xSemaphoreGive(m_mutex);
    return ret;                                     // 返回指针，调用方只读不拥有
}
```

配套的新帧写入逻辑在环形缓冲满时先 `pop` 最旧帧并 `cam_fb_return()` 归还给驱动，再 `push` 新帧——这就是"缓冲区归还责任"审计点的代码依据。

## 关键文件说明

| 文件/目录 | 职责 | 类型 |
|---|---|---|
| [`main/app_main.cpp`](main/app_main.cpp) | 摄像头、LCD、推理任务 | 课程代码 |
| [`main/frame_cap_pipeline.cpp`](main/frame_cap_pipeline.cpp) | 帧管线和 3 缓冲配置 | 课程代码 |
| [`main/catdog_classifier.hpp`](main/catdog_classifier.hpp) | ESP-DL 分类封装（softmax、`is_ready()` 检查） | 课程代码 |
| [`main/labels.hpp`](main/labels.hpp) | 类别标签 `{"cat", "dog"}` | 课程代码 |
| [`main/models/s3/catdog_mobilenet_v2.espdl`](main/models/s3/) | 最小案例 2 量化输出的部署模型 | 模型资产 |
| `components/who_cam/` | 摄像头驱动封装（`WhoS3Cam`） | 课程组件 |
| `components/who_frame_cap/` | 取帧节点、环形缓冲、peek 接口 | 课程组件 |
| `components/who_frame_lcd_disp/` | 新帧事件驱动的 LCD 显示任务（可挂 FPS 回调） | 课程组件 |
| `components/who_lcd/` | LCD/LVGL 底层封装 | 课程组件 |
| `components/who_task/` | 任务基类、`Yield2Idle` 与 Kconfig | 课程组件 |
| [`frame_audit.md`](frame_audit.md) | 作业证据和缓冲区审计要求 | 作业说明 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | 8MB flash、PSRAM、LCD 缓冲默认配置 | 构建配置 |
| [`partitions.csv`](partitions.csv) | `factory` 约 7 MB + `storage`（FAT）1 MB | 构建配置 |

注意：本目录的 `components/who_*` 同时被微课 04、扩展 04/04A 通过 `EXTRA_COMPONENT_DIRS` 复用，`main/models/s3/*.espdl` 也被它们通过 `EMBED_FILES` 嵌入——**不要移动或改名**，否则三个下游工程都会构建失败。

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| [`main/app_main.cpp`](main/app_main.cpp) | `kInferIntervalTicks` | 改变推理启动频率和结果新鲜度 |
| [`main/frame_cap_pipeline.cpp`](main/frame_cap_pipeline.cpp) | `kCameraFbCount=3` | 改变帧缓冲占用和管线余量 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `CONFIG_BSP_LCD_DRAW_BUF_HEIGHT` | 影响 LCD 绘制缓冲和内存占用 |
| [`main/labels.hpp`](main/labels.hpp) | 标签顺序 | 必须与训练/量化输出一致 |

修改示例——把推理间隔从 500 ms 改成 1 s，修改前：

```cpp
static constexpr TickType_t kInferIntervalTicks = pdMS_TO_TICKS(500);
```

修改后：

```cpp
static constexpr TickType_t kInferIntervalTicks = pdMS_TO_TICKS(1000);
```

这是编译期常量，必须重新 `idf.py build` 并烧录才生效。`kCameraFbCount` 调大（如 4）会多占约 112 KB PSRAM；调小到 2 会使环形缓冲长度（`fb_count - 2`）变成 0 触发断言失败——**不要低于 3**。

## 术语小表

| 术语 | 解释 |
|---|---|
| LCD FPS | LCD 实际显示帧率，不等于模型推理频率 |
| peek | 查看最新帧而不建立额外队列的访问策略 |
| 帧年龄 | 当前推理使用的帧距离采集完成的时间 |
| 丢帧 | 采集帧未被推理处理或被覆盖的现象 |
| 帧缓冲（fb） | 存放一整帧像素的内存块，本工程 3 块、每块约 112 KB、位于 PSRAM |
| 环形缓冲 | 新数据覆盖最旧数据的定长缓冲，`WhoFetchNode` 中长度为 1（`fb_count - 2`） |
| RGB565 | 每像素 2 字节的颜色格式（红 5 位、绿 6 位、蓝 5 位） |
| PSRAM | 外部伪静态 RAM，存帧缓冲和推理张量 |
| flash rodata | 固件中的只读模型资源区 |
| Top-1 | 置信度最高的那个类别及其分数 |
| softmax | 把模型原始分数归一化为和为 1 的概率的后处理 |
| FreeRTOS 任务 | 带优先级和独立栈的并发执行单元，数字大的先跑 |
| 新帧事件 | `WhoFetchNode` 更新环形缓冲后广播的 `NEW_FRAME` 事件位 |
| Yield2Idle / watchdog | 防饿死监控任务；看门狗检测任务长期不让出 CPU 并告警/复位 |

## 验证清单

- [ ] 提交目标板、IDF 版本、模型 hash 和构建配置；
- [ ] 至少记录连续递增的推理序号、Top-1、置信度和耗时；
- [ ] 另行记录采集/推理/丢帧或缓冲区证据；
- [ ] 重复启动停止后检查 PSRAM 和系统稳定性；
- [ ] 失败初始化不写成分类成功。

**讲师参考基线**

```text
硬件：ESP32-S3-EYE；CPU/帧缓冲/模型：以实际实验记录为准
证据：推理序号、Top-1、置信度、耗时、采集/推理计数和内存变化
状态：未取得当前批次实机数据前，标记为“参考值，待实机校准”
```

## 思考题与拓展挑战

**思考题**

1. 为什么实时推理优先取最新帧，而不是把所有帧排队？

   **参考答案：**模型耗时大于采集周期时，排队会造成延迟累积和内存增长；最新帧策略牺牲历史帧，换取结果时效和可控资源。

2. 为什么推理序号不能直接代表摄像头帧号？

   **参考答案：**推理每 500 ms 才看一帧，中间的帧都被环形缓冲覆盖；只有采集管线的帧计数和时间戳才能说明摄像头产生了多少帧。

3. 为什么 `classifier_task` 用 `xTaskCreate` 不绑核，而预览任务显式绑在 CPU0？

   **参考答案：**预览链路绑核保证流水线稳定在 CPU0；推理不绑核由调度器分配，恰好为最小案例 4 的绑核对比实验留下变量入口。

**拓展挑战**

- 在不改变模型的约束下补充采集帧号、帧时间戳和推理帧年龄日志；
- 设计一个能证明重复运行无帧缓冲泄漏的测试记录表。

