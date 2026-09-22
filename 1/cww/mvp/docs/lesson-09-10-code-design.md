# 第 9、10 集代码设计方案

## Summary

基于前 8 集现有代码，新增：

- 第 9 集微课：单模式语音性能基准；
- 第 9 集扩展：多模型、多频率和资源预算对比；
- 第 10 集微课：可重复运行的状态机骨架；
- 第 10 集扩展：接入真实摄像头、录音、猫狗推理和 SD 卡保存。

设计原则：

- 不新增 FreeRTOS 独立教学内容；
- 不使用 menuconfig，实验变量全部通过文本配置；
- 微课只展示一个核心现象；
- 扩展案例再接入真实硬件和异常处理；
- 复用已有 `voice_common`、ESP-SR、摄像头和猫狗推理代码。

## Implementation status

截至 2026-08-26，四个工程的源码已落地，ESP-IDF v5.4.3 本地构建已通过；第 9 集扩展的 VAD/WakeNet/MultiNet × 160/240 MHz 六种固件也已分别构建。共享音频读取接口统一为 `voice_read_samples(buffer, sample_count)`，第 10 集扩展已补充单调时间戳、动作耗时日志、结果日志、LCD 状态和失败临时文件清理。

真实开发板烧录、串口性能数据、三次记录文件检查以及拍照/录音/推理/SD 卡故障注入仍需在 ESP32-S3-EYE 上执行；仓库不写入虚构的板上结果。

## 第 9 集：语音性能指标与权衡

### 微课最小案例

工程目录：

```text
microcourses/09_audio_perf_tradeoff/
├── CMakeLists.txt
├── README.md
├── sdkconfig.defaults
└── main/
    ├── CMakeLists.txt
    ├── idf_component.yml
    ├── main.c
    ├── perf_config.h
    ├── voice_benchmark.c
    └── voice_benchmark.h
```

学生只修改：

```c
// main/perf_config.h

#define VOICE_BENCH_MODE_VAD      1
#define VOICE_BENCH_MODE_WAKENET  2
#define VOICE_BENCH_MODE_MULTINET 3

#define VOICE_BENCH_MODE VOICE_BENCH_MODE_VAD
#define VOICE_BENCH_DURATION_MS 10000
```

CPU 频率仍通过 `sdkconfig.defaults` 配置，不使用 menuconfig。

### 测量模式

每次运行只启用一个模式：

| 模式 | 测量对象 | 输出含义 |
|---|---|---|
| VAD | `afe_handle->fetch()` | AFE/VAD 处理一次音频帧的耗时 |
| WakeNet | 启用 WakeNet 的 AFE `fetch()` | 包含 AFE 和 WakeNet 的实时处理耗时 |
| MultiNet | `multinet->detect()` | MultiNet 命令识别处理耗时 |

日志格式固定为：

```text
[BENCH] mode=VAD cpu=240MHz
[BENCH] stage=afe_fetch elapsed_us=...
[BENCH] samples=... core=... internal_free=... psram_free=...
[BENCH] summary mode=VAD count=... avg_us=... min_us=... max_us=...
```

必须明确说明：WakeNet 的测量值是 AFE+WakeNet 组合耗时，不伪装成纯模型耗时。

### 实现方式

- 复用第 6 集的 AFE/VAD 初始化；
- 复用第 7 集当前实际目录 `microcourses/07_wakenet_wav` 中的 WakeNet 模型加载方式；
- 复用第 8 集的 MultiNet 配置和命令词加载方式；
- 使用 `esp_timer_get_time()` 测量微秒级耗时；
- 使用 `esp_clk_cpu_freq()` 输出实际 CPU 频率；
- 使用 `xPortGetCoreID()` 输出当前处理核心；
- 使用 `heap_caps_get_free_size()` 输出内部 RAM 和 PSRAM 余量；
- 运行固定 10 秒，按固定间隔输出摘要；
- 不输出 FPS、帧年龄、队列、watchdog 等第 4 集扩展指标。

### 共享音频接口修正

在实现第 9 集前，统一检查并修正 `components/voice_common` 的音频读取接口：

```c
esp_err_t voice_read_samples(int16_t *buffer, size_t sample_count);
```

接口参数统一使用“样本数量”，不再混用“字节数”和“样本数”。第 6、8 集同步迁移到该接口，避免性能测量受到缓冲区长度歧义影响。

## 第 9 集扩展：语音资源预算与配置选择

工程目录：

```text
extensions/09_audio_resource_budget/
├── CMakeLists.txt
├── README.md
├── sdkconfig.defaults
├── configs/
│   ├── cpu160.defaults
│   └── cpu240.defaults
├── tools/
│   └── parse_audio_bench.py
└── main/
    └── CMakeLists.txt
```

扩展工程通过 `main/CMakeLists.txt` 复用微课第 9 集的 `main.c`、`perf_config.h`、`voice_benchmark.c` 和头文件，不复制两份基准逻辑；扩展目录只保留矩阵配置、解析工具和工程入口。

扩展案例固定比较：

```text
VAD / WakeNet / MultiNet
160 MHz / 240 MHz
```

每组配置单独编译、烧录和测试，避免多个变量同时变化。

最终形成：

| 模式 | CPU | 平均耗时 | 最大耗时 | 内部 RAM | PSRAM | 稳定性 |
|---|---:|---:|---:|---:|---:|---|
| VAD | 160 MHz |  |  |  |  |  |
| VAD | 240 MHz |  |  |  |  |  |
| WakeNet | 160 MHz |  |  |  |  |  |
| WakeNet | 240 MHz |  |  |  |  |  |
| MultiNet | 160 MHz |  |  |  |  |  |
| MultiNet | 240 MHz |  |  |  |  |  |

扩展结论不预设“240 MHz 一定最好”，而要求学生根据实测数据选择配置，例如：

- 低频率满足实时要求且资源/功耗更低；
- 高频率降低延迟但增加功耗；
- MultiNet 只在唤醒后运行，不能按持续运行模型估算系统资源；
- WakeNet 长期运行时应优先关注稳定性和待机资源。

## 第 10 集：系统状态机设计

### 微课最小案例

工程目录：

```text
microcourses/10_system_state_machine/
├── CMakeLists.txt
├── README.md
├── sdkconfig.defaults
└── main/
    ├── CMakeLists.txt
    ├── idf_component.yml
    ├── main.c
    ├── state_machine.c
    ├── state_machine.h
    ├── mock_actions.c
    ├── mock_actions.h
    └── state_config.h
```

状态定义：

```c
typedef enum {
    APP_STATE_IDLE,
    APP_STATE_LISTENING,
    APP_STATE_COMMAND,
    APP_STATE_CAPTURE,
    APP_STATE_RECORD,
    APP_STATE_INFER,
    APP_STATE_SAVE,
    APP_STATE_FEEDBACK,
    APP_STATE_ERROR,
} app_state_t;
```

事件定义：

```c
typedef enum {
    APP_EVENT_START,
    APP_EVENT_WAKE_DETECTED,
    APP_EVENT_COMMAND_DETECTED,
    APP_EVENT_ACTION_DONE,
    APP_EVENT_ACTION_FAILED,
    APP_EVENT_TIMEOUT,
    APP_EVENT_CANCEL,
    APP_EVENT_RESET,
} app_event_t;
```

状态机核心接口：

```c
bool state_machine_step(
    app_state_t *state,
    app_event_t event
);
```

状态机本身不直接调用摄像头、麦克风或模型，只负责：

- 判断当前状态是否接受事件；
- 决定下一个状态；
- 输出状态迁移；
- 将非法事件转入错误状态；
- 支持取消、超时和复位。

### 微课运行方式

按键 GPIO0 触发正常路径：

```text
IDLE
  ↓ START
LISTENING
  ↓ WAKE_DETECTED
COMMAND
  ↓ COMMAND_DETECTED
CAPTURE
  ↓ ACTION_DONE
RECORD
  ↓ ACTION_DONE
INFER
  ↓ ACTION_DONE
SAVE
  ↓ ACTION_DONE
FEEDBACK
  ↓ ACTION_DONE
IDLE
```

动作由 `mock_actions.c` 自动返回成功，确保学生看到完整状态流转。

日志格式：

```text
[STATE] IDLE -> LISTENING event=START
[STATE] LISTENING -> COMMAND event=WAKE_DETECTED
[STATE] COMMAND -> CAPTURE event=COMMAND_DETECTED
[STATE] CAPTURE -> RECORD event=ACTION_DONE
[STATE] RECORD -> INFER event=ACTION_DONE
[STATE] INFER -> SAVE event=ACTION_DONE
[STATE] SAVE -> FEEDBACK event=ACTION_DONE
[STATE] FEEDBACK -> IDLE event=ACTION_DONE
```

通过 `state_config.h` 注入一个测试场景：

```c
#define STATE_SCENARIO_NORMAL       0
#define STATE_SCENARIO_FAIL_RECORD  1
#define STATE_SCENARIO_CANCEL       2
#define STATE_SCENARIO_TIMEOUT      3

#define STATE_MACHINE_SCENARIO STATE_SCENARIO_NORMAL
```

微课重点是“状态、事件、迁移”，不讲 FreeRTOS API。

## 第 10 集扩展：真实动作适配器

工程目录：

```text
extensions/10_state_machine_test/
├── CMakeLists.txt
├── README.md
├── sdkconfig.defaults
├── main/
│   ├── CMakeLists.txt
│   ├── idf_component.yml
│   ├── main.cpp
│   ├── real_actions.cpp
│   ├── real_actions.hpp
│   └── test_config.h
└── partitions.csv
```

状态机核心代码通过 `main/CMakeLists.txt` 直接复用第 10 集微课的 `state_machine.c/.h`，扩展工程只替换动作适配器；`real_actions.cpp` 将摄像头预览帧、录音、猫狗推理、SD 卡保存和 LCD 状态反馈串起来。

摄像头/LCD 组件通过 CMake 指向第 3 集扩展工程的共享组件目录，不在第 10 集扩展中复制；`partitions.csv` 为嵌入模型和 MicroSD 存储分别提供分区。

`test_config.h` 提供正常、拍照失败、录音失败、推理失败、保存失败、取消、命令超时和录音超时场景。可通过 `-D REAL_ACTION_SCENARIO=1..7` 构建异常验证固件，默认值 `0` 为正常闭环。

### 真实动作映射

| 状态 | 真实动作 |
|---|---|
| `CAPTURE` | 复用第 3/4 集摄像头 pipeline 获取一帧图像 |
| `RECORD` | 复用 `voice_common` 录制约 10 秒 WAV |
| `INFER` | 复用第 3/4 集 `CatDogClassifier` 进行猫狗推理 |
| `SAVE` | 将图像、WAV、分类结果和时间戳写入 SD 卡 |
| `FEEDBACK` | LCD 和串口显示成功/失败状态 |

为避免改动第 4 集实时预览逻辑，扩展案例使用“当前预览帧作为一次记录图像”，并将图像保存为带尺寸和格式说明的 RGB565 文件；如果后续确认 JPEG 编码器可稳定复用，再增加 JPEG 输出，不影响状态机接口。

### 异常路径

至少实现：

```text
CAPTURE_FAILED
RECORD_FAILED
INFER_FAILED
SAVE_FAILED
COMMAND_TIMEOUT
RECORD_TIMEOUT
CANCEL
```

所有异常路径必须：

1. 输出失败原因；
2. 进入 `ERROR`；
3. LCD 显示失败状态；
4. 释放当前图像、音频和模型资源；
5. 经过 `RESET` 或超时后回到 `IDLE`。

### 触发方式

扩展案例默认仍使用按键触发，保证测试可重复。WakeNet/MultiNet 真实语音触发不作为第 10 集扩展的必选变量，而保留为后续综合案例接入点：

```c
app_event_t app_trigger_event_from_voice(int command_id);
```

这样第 10 集完成真实动作和异常路径验证，同时不把第 5～10 集全部耦合成一个难以调试的大工程。

## 构建和验证

每个新工程都提供：

```text
CMakeLists.txt
main/CMakeLists.txt
main/idf_component.yml
sdkconfig.defaults
```

验证顺序：

1. 第 9 集微课工程编译；
2. 第 9 集分别运行 VAD、WakeNet、MultiNet 单模式；
3. 第 9 集扩展完成 160/240 MHz 对比；
4. 第 10 集微课运行正常路径；
5. 第 10 集微课运行失败、超时和取消场景；
6. 第 10 集扩展编译；
7. 按键触发一次真实记录；
8. 检查 WAV、图像和识别结果是否具有同一时间戳；
9. 注入拍照、录音、推理和 SD 卡失败；
10. 连续运行多次，确认错误后可以回到 `IDLE`。

验收日志至少包含：

```text
[STATE] ...
[ACTION] capture_ms=...
[ACTION] record_ms=...
[ACTION] infer_ms=...
[ACTION] save_ms=...
[RESULT] image=... audio=... label=... timestamp=...
```

## 文档同步

实现时同步更新：

- `microcourses/09_audio_perf_tradeoff/README.md`；
- `extensions/09_audio_resource_budget/README.md`；
- `microcourses/10_system_state_machine/README.md`；
- `extensions/10_state_machine_test/README.md`；
- `docs/curriculum-map.md`；
- `docs/build-verification.md`；
- 项目根目录 `README.md`；
- 根目录 `AGENTS.md`。

同时将文档中的旧目录名和旧表述统一为当前实际状态，特别是：

```text
microcourses/07_wakenet_wav
```

以及“第 7 集从 SD 卡 WAV 文件开始，扩展到板载麦克风实时语音”的教学链路。

## Assumptions

- 第 9 集默认基准模式为 VAD，学生通过 `main/perf_config.h` 切换到 WakeNet 或 MultiNet；
- CPU 频率通过 `sdkconfig.defaults` 或扩展案例中的文本配置文件切换；
- 第 10 集微课使用模拟动作适配器，不直接整合摄像头、录音和视觉推理；
- 第 10 集扩展接入真实摄像头、录音、推理和 SD 卡保存，但不强制接入 WakeNet/MultiNet 语音触发；
- 现有第 5～8 集代码和 `voice_common` 的接口问题在第 9 集实现前一并规范化；
- 所有构建验证先以 ESP-IDF 编译通过为准，真实设备测试再记录串口日志和文件产物。
