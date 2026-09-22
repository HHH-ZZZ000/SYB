# 扩展案例 7：WakeNet 实时语音

> 类型：`FW` ｜ 验证状态：参考值，待实机校准 ｜ 对应微课：[`microcourses/07_wakenet_wav`](../../microcourses/07_wakenet_wav/)

## 摘要

本案例把最小案例 7 微课的"SD 卡 WAV 文件输入"替换成 **ESP32-S3-EYE 板载麦克风 + AFE 实时采集**，持续检测官方唤醒词 `Hi ESP`（模型 `wn9_hiesp`）。程序用两个 FreeRTOS 任务分工：`feed_task`（CPU0）不断把麦克风 PCM 喂给 AFE，`detect_task`（CPU1）从 AFE 取结果、查看 `wakeup_state`。命中后打印 `state=WAKE_DETECTED`，并打开约 3 秒观察窗口，窗口结束回到 `state=WAIT_WAKE` 继续待机。本案例只做"唤醒"，MultiNet 命令识别留给最小案例 8；对应 Memory Pendant "待机→唤醒→命令→动作→待机"里的"待机+唤醒"环节。

## Quick Start

**预备知识：从"读文件"到"实时采集"多了什么**

微课 07 里音频是现成的 WAV 文件，输入完全可重复。实时场景里音频来自板载麦克风，是连续不断、边说边来、带环境噪声的数据流，于是多出几个必须解决的问题：

- **怎么读麦克风？** 用 I2S 外设。共享组件 [`voice_common.c`](../../components/voice_common/voice_common.c) 的 `voice_audio_init()` 配置 I2S（BCLK=GPIO41、WS=GPIO42、DIN=GPIO2），16 kHz 单声道。硬件每次给 32-bit 样本，`voice_read_samples()` 右移 14 位转成 WakeNet 需要的 16-bit。
- **原始信号很脏怎么办？** 交给 **AFE（Audio Front-End，音频前端）**：做降噪、自动增益、VAD 等处理，并在内部运行 WakeNet，直接告诉你"有没有唤醒"。这是与微课 07 的最大区别——微课直接调 `wn_iface->detect()`，这里通过 AFE 间接拿检测结果。
- **流式数据怎么组织任务？** 用"喂—取"双任务：`feed_task` 不停读麦克风并调 `afe_handle->feed()` 送进 AFE；`detect_task` 不停调 `afe_handle->fetch()` 取出结果、检查 `result->wakeup_state`。两个任务通过 AFE 内部缓冲区解耦，各跑各的节奏。
- **为什么待机只跑 WakeNet（分层省电）？** WakeNet 模型小、算力占用低，可以一直挂着听；MultiNet、拍照、视觉推理都是高负载任务。所以待机只跑 WakeNet，唤醒后才启动 MultiNet（最小案例 8），有效命令后才拍照录音（最小案例 10）——高负载任务由事件触发、完成后退出，不持续占用资源。
- **为什么绑核？** ESP32-S3 是双核，`feed_task` 放 CPU0、`detect_task` 放 CPU1，让"读麦克风"和"跑模型"互不抢占，降低实时抖动。


前置条件：ESP32-S3-EYE（带板载麦克风）；`model` 分区烧录 `Hi ESP` 唤醒词模型 `wn9_hiesp`（由 `sdkconfig.defaults` 的 `CONFIG_SR_WN_WN9_HIESP=y` 决定）。本案例**不需要** SD 卡或 WAV 文件。

```bash
cd extensions/07_wakenet_realtime
idf.py --version          # 确认 ESP-IDF 可用，报错就先按环境文档配置
idf.py set-target esp32s3 # 目标芯片 esp32s3
idf.py build              # 构建固件并自动打包 srmodels.bin，结束打印 Project build complete
idf.py -p <PORT> flash monitor   # 有开发板时烧录并打开串口
```

- `idf.py flash` 会通过 esp-sr 的 `add_dependencies(flash srmodels_bin)` 机制自动把模型写入 `model` 分区，无需额外的模型烧录命令。
- 烧录后先看 AFE/模型加载日志，出现 `state=WAIT_WAKE word=Hi ESP` 表示进入待机。
- **唤醒测试**：在安静环境对麦克风清楚说 `Hi ESP`，命中打印 `state=WAKE_DETECTED word_index=1`，约 3 秒后回到 `state=WAIT_WAKE`；重复 10~20 次统计成功率。
- **对照测试**：a) 安静但不说话——应一直停在 `WAIT_WAKE`；b) 放环境噪声/说别的词——观察是否"误唤醒"。
- 退出：monitor 里按 `Ctrl + ]`。

环境安装与 `<PORT>` 见仓库根 README 和 [`docs/environment-setup.md`](../../docs/environment-setup.md)。没有开发板时只能完成到 `idf.py build` 的构建验证，**不能**把唤醒结果写成"已实测"。

## 预期现象

下面是**格式示例，具体数值以实机为准**（TAG 为 `ext07_wakenet`）。启动待机、说 `Hi ESP` 命中、约 3 秒窗口结束：

```text
I (xxxx) ext07_wakenet: state=WAIT_WAKE word=Hi ESP
I (xxxx) ext07_wakenet: state=WAKE_DETECTED word_index=1
I (xxxx) ext07_wakenet: state=WAIT_WAKE
```

- `state=WAIT_WAKE word=Hi ESP`：待机监听中。启动打印一次，每个观察窗口结束后再打印一次。
- `state=WAKE_DETECTED word_index=N`：命中，`N` 是唤醒词索引（**从 1 开始**；本工程只加载 `Hi ESP`，正常应为 1）。命中后代码设 `pdMS_TO_TICKS(3000)` 的截止 tick。
- 约 3 秒后再次 `state=WAIT_WAKE`：观察窗口超时回到待机。这段窗口就是最小案例 8 接入 MultiNet 命令识别的位置。

失败路径：AFE `fetch` 返回空或 `ret_value == ESP_FAIL` 时打印 `fetch_error` 并退出检测任务；音频读取失败由 `ESP_ERROR_CHECK(voice_read_samples(...))` 触发；模型资源缺失时 AFE 创建环节会报错。命中率、误唤醒率和延迟属于**待实机测量**数值，无命中不能写成"唤醒成功"。

**常见问题排查**

| 现象 | 可能原因 | 解决办法 |
|---|---|---|
| 一直停在 `WAIT_WAKE`，说 `Hi ESP` 不命中 | 环境吵、离麦克风远、发音不清或音量偏低 | 安静环境、靠近麦克风、清楚发音；检查麦克风是否被遮挡 |
| 从没打印 `WAIT_WAKE`，程序像卡住 | 麦克风 I2S 初始化失败或 `fetch` 一直阻塞 | 确认 `voice_audio_init()` 成功、板子是 ESP32-S3-EYE、GPIO41/42/2 未被占用 |
| `fetch_error` 后不再响应 | AFE 内部错误或资源不足 | 检查 PSRAM 使能（`CONFIG_SPIRAM*`）和 `model` 分区模型，重新 build+flash |
| 报模型找不到/加载失败 | 未勾选 `CONFIG_SR_WN_WN9_HIESP` 或 `srmodels.bin` 未烧入 | 确认配置为 `y`，重新 `idf.py build flash` |
| 频繁误唤醒（没说也命中） | 环境噪声与唤醒词相似 | 换安静环境复测；记录误唤醒次数作为数据，不随意改模型阈值 |
| 启动即崩溃、提示内存不足 | PSRAM 未正确使能或 flash 大小配置不符 | 核对 `CONFIG_SPIRAM=y`、`CONFIG_SPIRAM_MODE_OCT=y`、`CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y` |

## 学习目标

- 解释"实时麦克风 → AFE → WakeNet"的数据链路，以及相比 WAV 离线输入多了哪些系统问题；
- 说明 `feed_task` / `detect_task` 双任务模型，以及为什么分别绑到 CPU0 和 CPU1；
- 运行待机、唤醒、监听窗口超时三条路径，读懂 `WAIT_WAKE` / `WAKE_DETECTED` 日志；
- 记录唤醒成功率、漏检、误唤醒和从说话到日志的响应延迟；
- 解释"待机时只跑 WakeNet"的分层省电设计。

## 原理讲解

**程序整体做了什么**

1. `voice_audio_init()` 初始化 I2S 麦克风；
2. `esp_srmodel_init("model")` 从 flash `model` 分区加载模型；
3. `afe_config_init(voice_get_input_format(), models, AFE_TYPE_SR, AFE_MODE_LOW_COST)` 生成 AFE 配置：输入格式 `"MN"`（单声道）、语音识别场景、低成本模式；
4. `esp_afe_handle_from_config()` + `create_from_config()` 创建 AFE 实例，`afe_config_free()` 释放配置对象；
5. 打印 `state=WAIT_WAKE word=Hi ESP`，创建 `feed_task`（CPU0）和 `detect_task`（CPU1）；
6. `detect_task` 每次 `fetch` 后判断 `wakeup_state == WAKENET_DETECTED`，命中就记录 `wake_word_index` 并设 3000 ms 截止 tick，窗口到期打印 `state=WAIT_WAKE`。

![麦克风到 WakeNet 的实时处理链路（AI 生成示意）](../../docs/assets/ai_generated/audio_processing_chain.png)

![WakeNet 与 MultiNet 的分层工作示意图（AI 生成示意）](../../docs/assets/ai_generated/wakenet_multinet_layers.png)

> 图：实时案例把文件输入替换为板载麦克风，通过 AFE 把数据送入 WakeNet。MultiNet 属于最小案例 8，本案例不承担命令识别。

## 整体流程图

```text
板载麦克风(I2S 16kHz/mono) → feed_task(CPU0) → AFE(降噪/增益/WakeNet) → detect_task(CPU1)
                                                                              ↓ fetch()
                                                              result->wakeup_state
                                                                  ├─ 未命中：继续 fetch，保持 WAIT_WAKE
                                                                  └─ WAKENET_DETECTED：
                                                                         打印 WAKE_DETECTED word_index=N
                                                                         ↓ 约 3 s 观察窗口
                                                                      打印 WAIT_WAKE（回到待机）
```

## 关键代码解析

以下片段均来自 [`main/main.c`](main/main.c)。

**1) `feed_task`：按 AFE 要求的块大小持续喂麦克风数据**

```c
static void feed_task(void *arg)
{
    esp_afe_sr_data_t *data = arg;
    int chunk = afe_handle->get_feed_chunksize(data);      // AFE 一次要多少样本
    int channels = afe_handle->get_feed_channel_num(data); // 几个声道（本工程单声道=1）
    int16_t *buffer = malloc(chunk * sizeof(int16_t) * channels);
    assert(buffer);
    while (true) {
        // 从麦克风读满样本（内部由 32-bit 右移 14 位得到 16-bit）
        ESP_ERROR_CHECK(voice_read_samples(buffer, (size_t)chunk * channels));
        afe_handle->feed(data, buffer);                    // 送进 AFE
    }
}
```

**2) `detect_task`：取结果、判断唤醒、维护 3 秒观察窗口**

```c
while (true) {
    afe_fetch_result_t *result = afe_handle->fetch(data);        // 取一帧处理结果
    if (!result || result->ret_value == ESP_FAIL) {
        ESP_LOGE(TAG, "fetch_error");                            // 失败路径
        break;
    }
    if (result->wakeup_state == WAKENET_DETECTED) {              // 命中唤醒词
        ESP_LOGI(TAG, "state=WAKE_DETECTED word_index=%d", result->wake_word_index);
        listening_until = xTaskGetTickCount() + pdMS_TO_TICKS(3000); // 3 秒窗口截止 tick
    }
    if (listening_until != 0 && xTaskGetTickCount() >= listening_until) {
        ESP_LOGI(TAG, "state=WAIT_WAKE");                        // 窗口到期，回到待机
        listening_until = 0;
    }
}
```

`result` 是 `afe_fetch_result_t`（`esp_afe_sr_iface.h` 定义），关键字段：`wakeup_state`（命中为 `WAKENET_DETECTED`）、`wake_word_index`（命中词索引，从 1 开始）、`ret_value`（fetch 返回状态）。

**3) `app_main`：初始化麦克风、模型、AFE，并绑核创建两个任务**

```c
ESP_ERROR_CHECK(voice_audio_init());                     // I2S 麦克风
srmodel_list_t *models = esp_srmodel_init("model");       // 从 model 分区加载模型
afe_config_t *config = afe_config_init(voice_get_input_format(), models,
                                       AFE_TYPE_SR, AFE_MODE_LOW_COST); // 输入格式"MN"=单声道
afe_handle = esp_afe_handle_from_config(config);
esp_afe_sr_data_t *data = afe_handle->create_from_config(config);
afe_config_free(config);
ESP_LOGI(TAG, "state=WAIT_WAKE word=Hi ESP");             // 进入待机
xTaskCreatePinnedToCore(feed_task,   "afe_feed",    8192, data, 5, NULL, 0); // 采集→CPU0
xTaskCreatePinnedToCore(detect_task, "wake_detect", 8192, data, 5, NULL, 1); // 检测→CPU1
```

## 关键文件说明

| 文件 | 职责 | 类型 |
|---|---|---|
| [`main/main.c`](main/main.c) | 实时音频、AFE 配置、feed/detect 双任务、3 秒唤醒窗口 | 课程代码 |
| [`main/CMakeLists.txt`](main/CMakeLists.txt) | 注册源文件，`REQUIRES voice_common esp-sr` | 构建脚本 |
| [`partitions.csv`](partitions.csv) | `factory` 2500K + `model` spiffs 5168K | 分区表 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `Hi ESP` 模型、PSRAM OCT/80M、240MHz、8MB flash | 构建配置 |
| [`../../components/voice_common/voice_common.c`](../../components/voice_common/voice_common.c) | I2S 麦克风初始化、`voice_read_samples()`、`voice_get_input_format()`（API 见同目录 `include/voice_common.h`） | 共享组件 |
| `managed_components/espressif__esp-sr/` | ESP-SR 第三方接口（`esp_afe_sr_iface.h`、`model_path.h` 等） | 第三方依赖 |
| `srmodels.bin` | 构建时自动打包、`flash` 写入 `model` 分区的模型镜像 | 生成物/部署资源 |

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| [`main/main.c`](main/main.c) | `pdMS_TO_TICKS(3000)` | 改变唤醒后观察窗口时长；窗口越短留给命令的时间越少 |
| [`main/main.c`](main/main.c) | `AFE_MODE_LOW_COST` | 换成 `AFE_MODE_HIGH_PERF` 会提升效果但更耗资源，需重新测内存和延迟 |
| [`main/main.c`](main/main.c) | feed/detect 的栈大小（`8192`）和核心（`0`/`1`） | 影响实时稳定性与资源占用；栈太小可能崩溃 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `CONFIG_SR_WN_WN9_HIESP` | 选择已有 WakeNet 唤醒词模型；关掉会导致模型找不到 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `CONFIG_SPIRAM*` / `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240` | PSRAM 与主频；AFE 需要 PSRAM，关掉会内存不足 |

## 术语小表

| 术语 | 解释 |
|---|---|
| WakeNet | ESP-SR 的唤醒词检测模型（本工程用 `wn9_hiesp`，词为 `Hi ESP`） |
| wake word（唤醒词） | 触发后续交互的固定短语，只负责"叫醒"设备 |
| AFE（音频前端） | 对麦克风原始音频做降噪/增益/VAD 等处理，并内部运行 WakeNet 的组件 |
| `feed` / `fetch` | AFE 的"喂数据"与"取结果"两个方向，分别由 feed_task/detect_task 调用 |
| `AFE_TYPE_SR` | AFE 场景类型：语音识别 |
| `AFE_MODE_LOW_COST` | AFE 工作模式：低成本/低资源占用 |
| `wakeup_state` | `afe_fetch_result_t` 字段，命中时为 `WAKENET_DETECTED` |
| `wake_word_index` | 命中的唤醒词索引，从 1 开始 |
| 观察窗口 | 命中唤醒后开启的约 3 秒时段，最小案例 8 会在其中接入 MultiNet |
| 误唤醒 | 没说目标词却产生了唤醒事件 |
| 绑核（pin to core） | 用 `xTaskCreatePinnedToCore` 把任务固定到某个 CPU，隔离采集与检测 |
| 分层省电 | 待机只跑轻量 WakeNet，高负载任务事件触发后短时运行 |

## 验证清单

- [ ] 记录唤醒词、模型版本、采样格式（16 kHz/mono/16 bit）和测试环境；
- [ ] 分别统计命中、漏检、噪声误唤醒的次数，并记录从"说唤醒词"到"打印 `WAKE_DETECTED`"的响应延迟；
- [ ] 验证命中后约 3 秒能自动回到 `state=WAIT_WAKE`；
- [ ] 验证 feed/detect 双任务分别运行在 CPU0/CPU1（可结合日志或任务信息）；
- [ ] 失败路径（`fetch_error`、模型缺失、麦克风初始化失败）都有明确日志；
- [ ] 不提交真实个人语音或含敏感路径的原始串口日志。

## 思考题与拓展挑战

**思考题**

1. 为什么实时 WakeNet 需要 AFE，而微课的 WAV 输入可以直接分块 `detect`？

   **参考答案：**实时麦克风信号连续、带噪、边说边来，需要 AFE 做降噪/增益等前端处理并管理采集缓冲；WAV 是可重复的离线样本，省去了整条采集与前端链路，所以能直接分块喂给 `detect`。

2. 为什么唤醒后要有一个约 3 秒的有限观察窗口，而不是一直保持"唤醒"状态？

   **参考答案：**有限窗口把后续命令处理限制在一次明确的交互里，避免设备长期停留在高负载状态。窗口内正好接入最小案例 8 的 MultiNet，超时后回到低功耗待机，符合分层省电设计。

3. 为什么把 `feed_task` 和 `detect_task` 分别绑到 CPU0 和 CPU1？

   **参考答案：**采集（读 I2S）和检测（跑模型）都是持续任务，分到两个核可以避免互相抢占、降低实时抖动，让喂数据和取结果各自稳定运行。

**拓展挑战**

- 在不保存任何原始语音的前提下，为 `detect_task` 增加命中/误唤醒计数器，按"安静/说话/环境噪声"三个场景分别统计，输出一张对照表。
- 设计三个固定噪声场景（如键盘声、音乐、多人交谈），在相同 3 秒窗口长度下比较误唤醒率，并用一句话解释差异来源。

