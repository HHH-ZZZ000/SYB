# 最小案例 7：WakeNet WAV 唤醒词检测

> 类型：`FW` ｜ 验证状态：参考值，待实机校准 ｜ 后续：[`extensions/07_wakenet_realtime`](../../extensions/07_wakenet_realtime/)

## 摘要

本案例从 MicroSD 卡读出两段事先准备好的 WAV 音频，跳过 44 字节文件头后，按 WakeNet 要求的固定样本块（chunk）逐块喂给唤醒词检测器，观察是否命中 `Hi ESP` 和 `Hi 乐鑫` 两个官方唤醒词。可观察产出是串口里的 `state=DETECTED`（命中）和 `state=END`（文件处理结束）日志。WAV 只是"算法输入测试素材"，用来在没有麦克风实时链路时先验证 WakeNet 接口；扩展案例 [`extensions/07_wakenet_realtime`](../../extensions/07_wakenet_realtime/) 会切换到板载麦克风实时采集。本案例对应 Memory Pendant "待机→唤醒→命令→动作→待机"分层模式中的"唤醒"环节。

## Quick Start

**预备知识**

- **唤醒词**：把设备从待机"叫醒"的固定短语，如 `Hi ESP`、`Hi 乐鑫`。它只负责叫醒，不做别的。
- **命令词**：醒来后要执行的具体指令（如"打开灯"），由 MultiNet 负责，是最小案例 8 内容，本案例不涉及。
- **为什么不自己训练**：唤醒词模型需要大量语音数据和算力。ESP-SR 已提供预训练模型（`wn9s_hiesp` 对应 `Hi ESP`，`wn9_hilexin` 对应 `Hi 乐鑫`），烧进 flash 的 `model` 分区加载即可。
- **WakeNet**：ESP-SR 里做唤醒词检测的模型家族（名字形如 `wn9`），输入 16-bit PCM 音频，输出"有没有听到唤醒词"。
- **WAV 与 PCM**：WAV 开头 44 字节是文件头（采样率、声道数、位深等元信息），后面是未压缩的 PCM 采样数据（16 bit = 一个 `int16_t`）。
- **chunk（样本块）**：WakeNet 一次处理的固定样本数，用 `get_samp_chunksize()` 查询，必须按块循环喂。


前置条件：一张 FAT32 格式的 MicroSD 卡，在卡的**根目录**放好两个 WAV 文件（文件名和路径代码里写死了）：

```text
/sdcard/hiesp.wav      ← 里面是有人说 "Hi ESP" 的音频
/sdcard/hilexin.wav    ← 里面是有人说 "Hi 乐鑫" 的音频
```

两个文件都必须是 **16 kHz 采样率、单声道（mono）、16 bit PCM** 的标准 WAV（44 字节头）。测试 WAV 不应包含真实个人语音，或只在本地使用、不提交仓库。

```bash
cd microcourses/07_wakenet_wav
idf.py --version          # 确认当前终端已配置 ESP-IDF，报 command not found 就先配环境
idf.py set-target esp32s3 # 目标芯片固定为 esp32s3（ESP32-S3-EYE）
idf.py build              # 构建固件，同时自动打包 srmodels.bin，结束打印 Project build complete
idf.py -p <PORT> flash monitor   # 有开发板时烧录并打开串口
```

- `idf.py flash` 会自动把模型烧进 `model` 分区（esp-sr 的 `add_dependencies(flash srmodels_bin)` 机制），**不需要额外的模型烧录命令**；前提是 `partitions.csv` 里有 `model` 分区（本工程已配置）。
- 烧录后串口依次出现 SD 卡挂载、模型加载、`processing ...` 和检测结果日志；在 monitor 里按 `Ctrl + ]` 退出。

环境安装与 `<PORT>` 的确定见仓库根 README 和 [`docs/environment-setup.md`](../../docs/environment-setup.md)。没有开发板或缺少模型资源时，只能执行到 `idf.py build` 完成构建验证，**不能**把 WAV 处理结果写成"已验证/已实测"。

## 预期现象

下面是**格式示例，具体数值（chunk 编号、时间戳）以实机为准**（TAG 为 `lesson07_wakenet`）：

```text
I (xxxx) lesson07_wakenet: processing /sdcard/hiesp.wav (Hi ESP)
I (xxxx) lesson07_wakenet: state=DETECTED word=Hi ESP chunk=NN
I (xxxx) lesson07_wakenet: state=END word=Hi ESP chunks=MMM
I (xxxx) lesson07_wakenet: processing /sdcard/hilexin.wav (Hi 乐鑫)
I (xxxx) lesson07_wakenet: state=DETECTED word=Hi 乐鑫 chunk=NN
I (xxxx) lesson07_wakenet: state=END word=Hi 乐鑫 chunks=MMM
```

- `processing <路径> (<唤醒词名>)`：开始处理某个 WAV。
- `state=DETECTED word=... chunk=NN`：**命中**，`NN` 是命中时读到第几个 chunk（从 1 计数）。一个文件可能出现 0 次或多次命中。
- `state=END word=... chunks=MMM`：**该文件处理结束**，`MMM` 是总块数。`END` 不代表命中，是否命中要看有没有单独的 `DETECTED` 行。

是否出现 `DETECTED` 取决于 WAV 内容和模型版本，不能预设为必然成功。失败路径有明确日志：SD 卡挂载失败在 `voice_sdcard_init()` 处报错；模型找不到打印 `WakeNet model not found: hiesp=... hilexin=...`；文件打不开打印 `cannot open <路径>`；内存分配失败打印 `malloc failed`。

**常见问题排查**

| 现象 | 可能原因 | 解决办法 |
|---|---|---|
| 只有 `processing` 和 `END`，从不出现 `DETECTED` | WAV 内容不是对应唤醒词，或采样率/格式不对 | 确认内容是清晰的对应唤醒词，格式为 16 kHz/单声道/16 bit |
| `cannot open /sdcard/hiesp.wav` | 文件不在 SD 卡根目录、文件名不符或卡未挂载成功 | 放到根目录并按 `hiesp.wav`/`hilexin.wav` 命名；确认卡是 FAT32、插好 |
| `WakeNet model not found: hiesp=NULL ...` | `model` 分区里没有对应模型 | 确认 `CONFIG_SR_WN_WN9S_HIESP=y`、`CONFIG_SR_WN_WN9_HILEXIN=y`，重新 build+flash |
| 音频内容对但检测迟钝、几乎不命中 | WAV 头不是标准 44 字节，`fseek(44)` 后数据错位 | 用工具导出为标准 PCM WAV（44 字节头） |
| 卡在 SD 卡初始化或反复重启 | SD 卡接触不良、供电不足或分区表配置错误 | 换卡重插；核对 `partitions.csv` 的 `model` 分区与 8MB flash 配置匹配 |

## 学习目标

- 说清"唤醒词"和"命令词"的区别，解释本课为什么先用 WAV 而不是麦克风；
- 准备 16 kHz、单声道、16 bit 的标准 PCM WAV 测试文件，放到 SD 卡指定路径；
- 运行两个官方预训练唤醒词模型（`wn9s_hiesp` 小型版、`wn9_hilexin`），读懂检测结果日志；
- 解释 WAV 文件头与 PCM 数据区的关系，以及为什么程序要 `fseek` 跳过 44 字节。

## 原理讲解

**为什么先用 WAV 而不用麦克风**

麦克风实时链路会同时引入 I2S 采集、缓冲、AFE 前端、任务调度、噪声等一大堆变量。固定 WAV 让输入完全可重复：同一段音频每次跑结果一样，可以先专注"WakeNet 接口怎么用、模型怎么选、命中日志长什么样"。验证清楚后，扩展案例再把输入源换成板载麦克风。

**程序整体做了什么**

1. `voice_sdcard_init()` 挂载 SD 卡到 `/sdcard`（共享组件 [`voice_common.c`](../../components/voice_common/voice_common.c) 实现）；
2. `esp_srmodel_init("model")` 从 flash `model` 分区读取所有已烧录的 ESP-SR 模型；
3. `esp_srmodel_filter(models, ESP_WN_PREFIX, "hiesp"/"hilexin")` 分别找到两个唤醒词模型；
4. `esp_wn_handle_from_name()` 拿到接口结构体，`create(name, DET_MODE_95)` 创建检测实例；
5. `process_wav_file()` 打开 WAV、跳过头部、按 chunk 循环 `fread` + `detect()`，命中打印 `DETECTED`，读完打印 `END`；
6. 最后 `destroy()` 释放两个检测实例。

整个过程不做开放域语音识别，也不触发拍照录音，只回答"这段音频里有没有唤醒词"。

![WAV 文件结构示意图（AI 生成示意）](../../docs/assets/ai_generated/wav_file_structure.png)

> 图：程序跳过 WAV 头部后，把 PCM 数据按固定 chunk 送入 WakeNet。图中结构用于理解文件布局，实际字段以 WAV 规范和代码为准。

## 整体流程图

```text
/sdcard/hiesp.wav 或 hilexin.wav
        ↓ 跳过 44 字节 WAV 头
16-bit PCM chunk → WakeNet detect()
        ↓
返回值 == WAKENET_DETECTED ? → 打印 state=DETECTED
        ↓（文件读完）
state=END（本文件处理结束，不代表命中）
```

## 关键代码解析

以下片段均来自 [`main/main.c`](main/main.c)。

**1) 处理单个 WAV 文件：跳过头部 + 按 chunk 喂数据**

```c
#define WAV_HEADER_SIZE 44
// fopen 失败时打印 cannot open <路径> 并返回；malloc 失败打印 malloc failed
fseek(file, WAV_HEADER_SIZE, SEEK_SET);       // 跳过 44 字节 WAV 头，定位到 PCM 数据区
int samples_per_chunk = wn_iface->get_samp_chunksize(wn_data); // 问模型：一次要喂多少样本
int16_t *buffer = malloc(samples_per_chunk * sizeof(int16_t)); // 每个样本 16 bit = 2 字节
int chunks = 0;
// 每次读满一个 chunk 的 int16 样本；读不满（文件结尾）就退出循环
while (fread(buffer, sizeof(int16_t), samples_per_chunk, file) == (size_t)samples_per_chunk) {
    chunks++;
    if (wn_iface->detect(wn_data, buffer) == WAKENET_DETECTED) {   // 命中判断
        ESP_LOGI(TAG, "state=DETECTED word=%s chunk=%d", word_name, chunks);
    }
}
ESP_LOGI(TAG, "state=END word=%s chunks=%d", word_name, chunks);   // 文件处理结束
```

要点：`get_samp_chunksize()` 返回的是**样本数**（不是字节数）；`WAV_HEADER_SIZE=44` 是对"标准 PCM WAV"的输入假设。

**2) 加载模型列表并筛选两个唤醒词**

```c
ESP_ERROR_CHECK(voice_sdcard_init());                 // 挂载 SD 卡到 /sdcard
srmodel_list_t *models = esp_srmodel_init("model");    // 从 flash 的 model 分区读取模型
char *wn_hiesp   = esp_srmodel_filter(models, ESP_WN_PREFIX, "hiesp");   // ESP_WN_PREFIX == "wn"
char *wn_hilexin = esp_srmodel_filter(models, ESP_WN_PREFIX, "hilexin");
if (!wn_hiesp || !wn_hilexin) {                        // 任一模型缺失就报错退出
    ESP_LOGE(TAG, "WakeNet model not found: hiesp=%s hilexin=%s",
             wn_hiesp ? "ok" : "NULL", wn_hilexin ? "ok" : "NULL");
    return;
}
```

**3) 创建检测实例、处理文件、释放**

```c
esp_wn_iface_t *iface_hiesp = esp_wn_handle_from_name(wn_hiesp);   // 拿到接口函数表
model_iface_data_t *data_hiesp = iface_hiesp->create(wn_hiesp, DET_MODE_95); // 创建实例
// hilexin 同理创建后，分别处理两个文件：
process_wav_file("/sdcard/hiesp.wav",   iface_hiesp,   data_hiesp,   "Hi ESP");
process_wav_file("/sdcard/hilexin.wav", iface_hilexin, data_hilexin, "Hi 乐鑫");
iface_hiesp->destroy(data_hiesp);       // 用完释放
iface_hilexin->destroy(data_hilexin);
```

`DET_MODE_95` 是 WakeNet 的检测灵敏度档位（`esp_wn_iface.h` 定义），数字越大越容易命中、也越容易误报。

## 关键文件说明

| 文件 | 职责 | 类型 |
|---|---|---|
| [`main/main.c`](main/main.c) | WAV 读取、跳过头部、分块、WakeNet 检测 | 课程代码 |
| [`main/CMakeLists.txt`](main/CMakeLists.txt) | 注册源文件，`REQUIRES voice_common esp-sr` | 构建脚本 |
| [`partitions.csv`](partitions.csv) | `factory` 应用分区 2500K + `model` spiffs 分区 5168K | 分区表 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | 选择 `hiesp`/`hilexin` 模型、PSRAM、240MHz、8MB flash | 构建配置 |
| [`../../components/voice_common/voice_common.c`](../../components/voice_common/voice_common.c) | SD 卡挂载 `voice_sdcard_init()` 等公共实现 | 共享组件 |
| `managed_components/espressif__esp-sr/` | ESP-SR 第三方模型与接口（`esp_wn_iface.h`、`model_path.h` 等） | 第三方依赖 |
| `srmodels.bin` | 构建时自动打包、`flash` 时写入 `model` 分区的模型镜像 | 生成物/部署资源 |

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| [`main/main.c`](main/main.c) | `WAV_HEADER_SIZE=44` | 只适用于标准 PCM WAV；头部不是 44 字节会数据错位、无法命中 |
| [`main/main.c`](main/main.c) | `create(..., DET_MODE_95)` | 改变检测灵敏度；改档后需重新记录误检/漏检情况 |
| [`main/main.c`](main/main.c) | `process_wav_file("/sdcard/hiesp.wav", ...)` | 改路径/文件名可测试其它 WAV，但需与 SD 卡上实际文件一致 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `CONFIG_SR_WN_WN9S_HIESP` / `CONFIG_SR_WN_WN9_HILEXIN` | 决定烧进 `model` 分区的唤醒词模型；关掉会导致 `WakeNet model not found` |
| SD 卡文件 | 采样率/声道/位深 | 与 16 kHz/mono/16 bit 不符会让检测结果无意义或完全不命中 |

## 术语小表

| 术语 | 解释 |
|---|---|
| WakeNet | ESP-SR 中负责唤醒词检测的模型家族（如 `wn9s_hiesp`） |
| wake word（唤醒词） | 把设备从待机"叫醒"的固定短语，如 `Hi ESP` |
| command word（命令词） | 醒来后要执行的具体指令，由 MultiNet 负责（最小案例 8 内容，本案例不涉及） |
| WAV | 带 44 字节文件头的音频容器格式 |
| PCM | WAV 中未压缩的音频数据区，本案例为 16-bit 有符号整数 |
| chunk（样本块） | 一次交给 WakeNet 的连续样本数，由 `get_samp_chunksize()` 查询 |
| `DET_MODE_95` | WakeNet 的检测灵敏度档位，越大越激进 |
| `WAKENET_DETECTED` | `detect()` 的返回值，表示命中唤醒词 |
| `esp_srmodel_init` / `esp_srmodel_filter` | 从 flash `model` 分区加载模型列表 / 按关键字筛选模型 |
| `model` 分区 | `partitions.csv` 中存放 ESP-SR 模型的 spiffs 分区 |
| `srmodels.bin` | 构建时自动打包、`flash` 时写入 `model` 分区的模型镜像 |
| AFE | 音频前端（降噪/回声消除等）；本 WAV 案例不用它，扩展案例才引入 |

## 验证清单

- [ ] 两个 WAV 已确认为 16 kHz / mono / 16 bit，且放在 SD 卡根目录、命名为 `hiesp.wav`/`hilexin.wav`；
- [ ] 日志能区分 `state=DETECTED`（命中）和 `state=END`（文件结束），未把 `END` 误当命中；
- [ ] 缺文件、缺模型等失败路径都能看到对应错误日志；
- [ ] 记录了实际是否命中和命中时的 chunk 编号（参考值，待实机校准）；
- [ ] 测试 WAV 不含真实个人语音，或仅在本地使用且不提交仓库。

## 思考题与拓展挑战

**思考题**

1. 为什么最小案例 7 先使用 WAV，而不是直接开始实时麦克风？

   **参考答案：**固定文件让输入完全可重复，可以先隔离 WakeNet 接口、模型选择和命中日志这些核心问题。实时麦克风会额外引入采集、AFE、调度和噪声等变量，等离线这层验证清楚后再切换更稳妥。

2. `state=END` 是否代表一定检测到了唤醒词？

   **参考答案：**不代表。`END` 只表示这个文件的所有完整 chunk 都处理完了，是否命中要看有没有单独出现 `state=DETECTED` 行。一个文件可能 `END` 却从未 `DETECTED`。

3. 为什么代码要 `fseek(file, 44, SEEK_SET)`？

   **参考答案：**标准 PCM WAV 的前 44 字节是文件头，不是音频采样。跳过后文件指针才指向真正的 PCM 数据区，`fread` 读到的才是能喂给 WakeNet 的 `int16_t` 样本。

**拓展挑战**

- 为 WAV 输入增加采样率、声道和位深检查：读取文件头字段，与 16 kHz/mono/16 bit 不符则打印明确错误并提前退出，而不是喂错误数据。
- 准备含唤醒词的正例和不含唤醒词的负例各若干，统计每个文件的命中次数和总 chunk 数，在不保存原始语音的前提下比较 `DET_MODE_95` 与更低档位的漏检/误检差异。

