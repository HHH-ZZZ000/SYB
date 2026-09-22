# README 写作与验收计划：22 个教学案例

## 1. 目标与范围

为 `microcourses/` 和 `extensions/` 下的 22 个教学案例维护统一、可自学、可验收的中文 `README.md`。文档应让学生知道：做什么、为什么做、如何运行、看到什么、如何判断成功，以及失败时如何处理。

当前 22 个文档的组成是：

- 10 个微课；
- `extensions/` 下 11 个扩展案例；
- `extensions/03_live_catdog_assignment` 这 1 个阶段性作业。

ESP32 固件案例的目标板固定为 ESP32-S3-EYE，目标芯片固定为 `esp32s3`。Python 训练和量化案例不要求烧录开发板，但必须明确其产物将部署到 `esp32s3`。

覆盖方式：更新各案例目录下的 `README.md`。覆盖前必须完成旧文档素材盘点，不能因改模板丢失已有命令、日志、实测数据、评分标准或链接。

## 2. 文档类型与统一模板

### 2.1 三种文档类型

| 类型 | 案例 | Quick Start 和预期现象的规则 |
|---|---|---|
| `PY` Python 模型流水线 | 微课 01、02；扩展 01、02 | 使用 conda、pip 和 Python 命令；预期现象写标准输出、生成文件和数值，不要求串口、烧录或 `idf.py` |
| `FW` ESP32 固件实验 | 微课 03～10；扩展 03 静态推理、04～10 | 使用 ESP-IDF 构建；写明模型/WAV/SD 卡等前置条件；有开发板时再烧录和采集串口 |
| `ASSIGNMENT` 阶段性作业 | 扩展 03 实时猫狗作业 | 在 `FW` 模板基础上增加评分证据、提交物和讲师参考基线 |

不能要求所有案例都执行同一串 `clone/conda/idf.py/flash/monitor` 命令：Python 案例没有固件，固件案例也不应在每个 README 重复仓库克隆步骤。

### 2.2 12 节固定结构

所有 22 个 README 使用以下 12 个二级标题，并保持顺序一致。顺序遵循"先动手运行，再了解原理、细节"：摘要之后紧跟 Quick Start 和预期现象，让学生先跑通、看到现象，再进入学习目标、原理和代码细节。类型差异写入对应章节，不另起一套标题。所有三级标题一律转为加粗标签（`**标题**`）；"预备知识"以加粗标签放在 Quick Start 开头，"常见问题排查"以加粗标签放在预期现象内。

| 节 | 标题 | 必须包含的内容 |
|---:|---|---|
| 1 | 摘要 | 2～3 句：输入 → 处理 → 可观察产出 → 所属课程主题 |
| 2 | Quick Start | 该类型可直接执行的命令、前置条件、输入文件、输出目录和退出方式 |
| 3 | 预期现象 | 成功现象、逐行解读、失败路径和恢复方式；数据必须标注验证状态；常见问题排查以加粗标签放在本小节内 |
| 4 | 学习目标 | 3～5 条可检验目标，使用“运行/解释/测量/比较/判断”等动词 |
| 5 | 原理讲解 | 只讲本案例需要的概念，并说明为什么采用当前方案；不在此处堆代码 |
| 6 | 整体流程图 | ASCII 或 Mermaid；`PY` 标注脚本和产物，`FW`/`ASSIGNMENT` 标注状态、日志或错误码 |
| 7 | 关键代码解析 | 3～6 个片段；先解释“为什么需要”，再解释实现；使用文件链接和符号名 |
| 8 | 关键文件说明 | 文件 → 职责表格，区分课程代码、共享组件、第三方依赖和生成物 |
| 9 | 配置说明 | “改哪个文件/配置项 → 改成什么 → 现象如何变化”；不要求使用 `menuconfig` |
| 10 | 术语小表 | 术语 → 一句话解释，首次出现的缩写必须覆盖 |
| 11 | 验证清单 | 学生自查项；`ASSIGNMENT` 和扩展案例额外提供“讲师参考基线”占位及填写格式 |
| 12 | 思考题与拓展挑战 | 思考题 2～3 道并给参考答案；拓展挑战 1～2 个，只给目标和约束，不给答案 |

代码围栏中的 `#include`、`#define` 和配置片段不能被文档检查器误识别为标题；代码必须放在 fenced code block 中，不能用裸行模拟代码标题。

### 2.3 类型专属内容

#### `PY` 案例

- Quick Start 只包含 `conda`、依赖安装、训练/量化命令和产物检查；不写 `idf.py set-target`、`flash` 或串口日志要求。
- 预期现象使用 Python 标准输出、loss/误差、文件大小、输出文件清单等；如果引用历史运行结果，标记为“已实测”并注明来源。
- 配置说明覆盖 epochs、数据路径、校准数据、量化选项和输出目录等真实配置。

#### `FW` 案例

- Quick Start 假设当前终端已配置 ESP-IDF，并能执行 `idf.py --version`；实际步骤使用 `idf.py set-target esp32s3`、`idf.py build`；烧录和 monitor 使用可替换的 `<PORT>`。
- 明确模型是嵌入固件、从 SD 卡读取，还是需要额外烧录/复制；明确 WAV 的采样率、声道、位深和文件名。
- 没有开发板时，构建证据和板上运行证据分开写，不能把构建通过写成运行通过。

#### `ASSIGNMENT` 案例

- 除功能步骤外，列出学生提交的帧号、Top-1、置信度、耗时、丢帧、泄漏和连续运行证据。
- 讲师参考基线必须标注硬件、IDF 版本、配置、模型和测试时长。

## 3. 写作约定

- 从第 5 集开始说明语言边界：本仓库的 ESP-DL 调用代码使用 C++，ESP-SR/共享音频示例使用 C；不要将此表述扩大为所有 ESP-DL 或 ESP-SR API 只能使用某一种语言。
- 不设置“课前小修改”或独立的“常见问题”章节；常见失败、错误原因和恢复方式统一放入第 3 节“预期现象”。
- 配置一律采用显式文本文件、脚本参数或 CMake 变量。可以解释“不使用 menuconfig”的原因，但不把 `idf.py menuconfig` 作为操作步骤。
- 代码引用使用相对 Markdown 链接、文件路径和函数/类/宏名称。行号只在代码最终稳定后生成，不能在计划阶段写死易失效的行号。
- 每个 README 顶部注明案例类型（`PY`、`FW` 或 `ASSIGNMENT`）和当前验证状态：`已实测`、`参考值，待实机校准` 或 `待验证`。
- 不提交真实个人照片、个人语音、密码、局域网密钥、访问令牌或含敏感信息的串口日志；测试素材必须来自合规公开数据、合成数据或课程提供的脱敏素材，并记录许可证/来源。

## 4. Quick Start 环境基线

根 README 和 `docs/environment-setup.md` 负责说明仓库获取与环境安装；案例 README 只引用它们，不重复硬编码仓库 URL、用户目录或串口名。

本计划不要求个人 shell 别名或环境辅助函数，只验证当前终端能够执行 `idf.py --version`。如果该命令不可用，应先按 `docs/environment-setup.md` 配置 ESP-IDF，再返回案例步骤。

### `PY` 基线

```bash
conda activate esp32s3
python -m pip install -r <requirements-file>
python <train-or-quantize-script>
```

README 必须补充 `<requirements-file>`、输入产物路径、输出目录和成功判定。

### `FW`/`ASSIGNMENT` 基线

```bash
cd <case-directory>
idf.py --version
idf.py set-target esp32s3
idf.py build
idf.py -p <PORT> flash monitor
```

没有开发板时，Quick Start 应明确“执行到 `idf.py build` 即可完成主机侧验证”。不得使用固定的 `/dev/cu.*` 路径；串口速率只有在案例确实需要时才显式指定。

## 5. 案例清单

表中只记录稳定的文件路径和符号/主题，不记录尚未稳定的行号。

### 5.1 微课（10 个）

| 集数 | 类型 | 路径 | 主题 | 关键文件/符号 |
|---:|---|---|---|---|
| 01 | `PY` | `microcourses/01_train_sin_model` | Python 训练 sin MLP | `sin_model.py`、训练入口、数据/导出函数 |
| 02 | `PY` | `microcourses/02_quantize_sin_model` | ESP-PPQ 量化 ONNX → `.espdl` | `quantize_onnx_model.py`、校准与导出配置 |
| 03 | `FW` | `microcourses/03_run_sin_model` | ESP-DL 板端推理和三种调用方式 | `main/app_main.cpp`、`main/CMakeLists.txt` |
| 04 | `FW` | `microcourses/04_live_infer_tuning` | 实时推理任务分配与 CPU/频率调优 | `main/app_main.cpp`、`main/perf_config.h` |
| 05 | `FW` | `microcourses/05_mic_recording` | 麦克风固定时长录音 | `main/main.c`、`voice_common` |
| 06 | `FW` | `microcourses/06_vad_detection` | VAD 人声检测和 feed/fetch 链路 | `main/main.c`、AFE/VAD 配置 |
| 07 | `FW` | `microcourses/07_wakenet_wav` | WakeNet WAV 离线验证 | `main/main.c`、WAV 读取和 WakeNet 初始化 |
| 08 | `FW` | `microcourses/08_multinet_command` | WakeNet + MultiNet 命令识别 | `main/main.c`、命令词配置和状态流 |
| 09 | `FW` | `microcourses/09_audio_perf_tradeoff` | VAD/WakeNet/MultiNet 语音性能基准 | `main/main.c`、`perf_config.h`、`voice_benchmark.c` |
| 10 | `FW` | `microcourses/10_system_state_machine` | 9 状态、8 事件的系统状态机 | `state_machine.h/.c`、`state_config.h`、`mock_actions.c` |

### 5.2 扩展案例与阶段性作业（12 个目录）

| 目录序号 | 类型 | 路径 | 主题 | 关键文件/符号 |
|---:|---|---|---|---|
| 01 | `PY` | `extensions/01_train_catdog_model` | 猫狗 MobileNetV2 训练 | `train_catdog.py`、数据集和训练入口 |
| 02 | `PY` | `extensions/02_quantize_catdog_model` | 猫狗模型量化 | `quantize_catdog.py`、校准与导出配置 |
| 03 | `FW` | `extensions/03_catdog_static_infer` | SD 卡模型和 JPEG 静态推理 | `main/app_main.cpp`、`catdog_classifier.hpp` |
| 03A | `ASSIGNMENT` | `extensions/03_live_catdog_assignment` | LCD 实时猫狗阶段性作业 | `main/app_main.cpp`、`frame_cap_pipeline.cpp`、评分标准 |
| 04 | `FW` | `extensions/04_live_infer_optimized` | `04_live_infer_trace` 的实时推理优化版 | `main/app_main.cpp`、FPS/推理/稳定性日志 |
| 04A | `FW` | `extensions/04_live_infer_trace` | 卡顿基线与 Chrome Trace JSON/Perfetto 阶段时间线 | `main/app_main.cpp`、`main/trace_json.cpp`、串口 JSON |
| 05 | `FW` | `extensions/05_recording_playback_verify` | 录音、SD 卡 WAV 和回放 | `main/main.c`、录音/播放路径 |
| 06 | `FW` | `extensions/06_vad_stability_test` | VAD 多轮稳定性 | `main/main.c`、轮次和汇总统计 |
| 07 | `FW` | `extensions/07_wakenet_realtime` | 板载麦克风 WakeNet 实时唤醒 | `main/main.c`、检测任务 |
| 08 | `FW` | `extensions/08_command_action_binding` | 命令词到应用回调 | `main/main.c`、命令处理和回调 |
| 09 | `FW` | `extensions/09_audio_resource_budget` | 3 模式 × 2 CPU 语音资源矩阵 | `main/CMakeLists.txt`、`tools/run_matrix.sh`、解析脚本 |
| 10 | `FW` | `extensions/10_state_machine_test` | 状态机接真实摄像头和音频链路 | `main/main.cpp`、`real_actions.cpp`、`test_config.h` |

扩展目录的“目录序号”是教学清单序号，不等同于路径中的数字；`03_live_catdog_assignment` 单独标为 `03A`，避免与静态推理案例混淆。

### 5.3 扩展案例 4A 的 Chrome Trace JSON 与 Perfetto 方案

完整方案单独保存于 [`docs/extension-04-perfetto-trace-json-plan.md`](extension-04-perfetto-trace-json-plan.md)。本计划只保留以下执行边界：

- 火焰图式阶段时间线只加入扩展案例 4A，微课 04 和已有性能扩展不增加相关内容；
- 第一版采用“ESP32 串口打印 Chrome Trace JSON → 开发者手动复制到 `trace.json` → Perfetto UI 打开”；
- 第一版不引入 Function Tracing、SystemView、JTAG 或设备端文件保存；
- 先实现阶段级性能时间线，后续再评估经典 SVG 火焰图或函数级追踪。

当前状态：独立方案、追踪代码、扩展案例工程和 README 已完成；Trace 开关开启/关闭的主机侧构建均已通过，实机串口和 Perfetto 验证仍待硬件条件具备后完成。

## 6. 执行批次与交付物

每批完成后先运行文档检查器，再进入下一批。状态必须从 `待执行` 改为 `进行中`、`已检查`，不能只凭文件已生成就标记完成。

| 批次 | 案例 | 交付物 | 状态 |
|---|---|---|---|
| `mc-01-02` | 微课 01、02 | Python 模板、产物路径、量化前后对照 | 已检查 |
| `mc-03-04` | 微课 03、04 | 固件 Quick Start、板端日志、性能数据状态标记 | 已检查 |
| `mc-05-06` | 微课 05、06 | 录音/WAV、VAD 流程和失败路径 | 已检查 |
| `mc-07-08` | 微课 07、08 | WAV 前置条件、WakeNet/MultiNet 命令配置 | 已检查 |
| `mc-09-10` | 微课 09、10 | 性能基准、状态机图和异常练习 | 已检查 |
| `ext-01-03` | 扩展 01、02、03 静态推理 | 猫狗模型训练→量化→SD 卡推理链路 | 已检查 |
| `ext-03A-04` | 实时猫狗作业、扩展 04 | 评分标准、性能基线和稳定性证据 | 已检查 |
| `ext-05-06` | 扩展 05、06 | 录音回放、VAD 多轮统计和讲师基线 | 已检查 |
| `ext-07-10` | 扩展 07～10 | 实时唤醒、命令绑定、资源矩阵、真实状态机 | 已检查 |

## 7. 素材、实测数据与证据管理

### 7.1 改写前盘点

当前仓库已盘点出 22 个 README，但它们尚未统一为 12 节模板。4 个 Python 案例不应被要求提供 CMake、`sdkconfig.defaults` 或串口日志；其余固件/作业案例再按 `FW` 或 `ASSIGNMENT` 规则检查。

覆盖旧 README 前，为每个案例建立 `docs/readme-evidence-manifest.yml`（或等价的机器可读清单），至少记录：

```yaml
- case: microcourses/03_run_sin_model
  type: FW
  evidence_status: measured
  source_file: microcourses/03_run_sin_model/README.md
  source_kind: serial|stdout|build|reference
  tested_on: ESP32-S3-EYE
  idf_version: <version-or-unknown>
  config: <cpu/model/input configuration>
  artifacts: <paths or log identifiers>
  retained_in_readme: true
```

没有来源、硬件、配置或验证状态的数据不能写成“真实串口日志”。没有开发板时可以保留日志格式示例，但必须标注“示例/参考值，待实机校准”。

### 7.2 已知实测数据必须保留

当前至少需要登记并迁移以下数据：

- 微课 03：三次运行约 `64 us / 61 us / 60 us`，输入 `1.000000`，输出 `0.997240`，以及 load/build/test 时间；
- 微课 04：CPU0/160 MHz 约 `3273 ms`、CPU1/160 MHz 约 `5140 ms`、CPU0/240 MHz 约 `2984 ms`，并保留“提频降低延迟、绑核主要用于隔离”的结论；
- 扩展 04：预览约 `20 FPS`、CPU1/240 MHz 推理约 `4696～4709 ms`、推理周期约 `5.20 s`、`frame_age` 约 `112～154 ms`，以及低优先级方案的 watchdog/延迟问题；
- 实时猫狗阶段性作业：保留帧号递增、Top-1、置信度、推理耗时、丢帧、无泄漏等评分证据要求。

当前 `extensions/03_live_catdog_assignment/README.md` 只有评分证据要求，没有可追溯的“240 MHz 下 1.7～1.9 s/帧”实测来源；该数字必须先在证据清单中确认来源，确认前不得写入新 README 的“已实测”内容。

### 7.3 日志与隐私规则

- 成功日志和失败日志都要给出来源状态；失败注入日志必须注明是“注入场景”，不能伪装成自然故障。
- 串口设备路径统一写成 `<PORT>`；不要把个人用户名、真实录音路径或网络凭据复制进 README。
- 每条模型、数据集、WAV 或图片素材记录来源和许可证；个人照片/语音只允许本地测试，不进入仓库。

## 8. 自动检查与最终验收

新增或维护 `tools/check_readme_docs.py`，检查 Markdown 时必须正确忽略 fenced code block 中的内容。检查器至少验证：

1. 预期的 22 个案例目录各有一个 `README.md`；
2. 12 个二级标题存在且顺序一致；
3. `PY` README 不要求固件烧录，`FW`/`ASSIGNMENT` README 包含目标芯片和构建命令；
4. 本地 Markdown 链接、引用的文件路径和关键符号存在；不接受过期的固定行号；
5. Quick Start 使用 `<PORT>`，不包含当前用户目录或固定串口名；
6. 实测数字附近存在证据状态和来源；“参考值/待实机”不能被误标为已实测；
7. 第 9 节没有把 `idf.py menuconfig` 作为操作命令；
8. 第 11 节包含验证清单，扩展/作业包含“讲师参考基线”；
9. 第 12 节的思考题有答案，拓展挑战没有直接答案；
10. README 不包含凭据、个人照片、个人语音或未脱敏日志。

最终验收门槛：

- [x] 22/22 README 使用 12 节固定结构和正确案例类型；
- [x] 22/22 Quick Start 可从根目录文档获得完整环境前置条件；
- [x] 22/22 预期现象同时覆盖成功和失败/恢复路径；
- [x] 22/22 代码解析使用稳定的文件链接和符号名；
- [x] 所有历史实测数据已登记、迁移或明确说明无法确认来源；
- [x] 所有未实机数据均标注“参考值，待实机校准”或“待验证”；
- [x] 链接、路径、标题、敏感信息和证据状态检查全部通过；
- [ ] 目标板上的烧录、串口、SD 卡和连续运行结果单独记录，不用文档改写代替实机验收。

## 9. 风险与未决事项

- 当前部分案例只有主机侧源码或构建证据，没有 ESP32-S3-EYE 实机日志；写作批次不能自行补造板上结果。
- ESP-SR 的模型版本、命令词形式和 `srmodels.bin` 准备方式可能随依赖版本变化，README 必须以仓库锁定版本和实际示例为准。
- 资源矩阵的平均耗时、最大耗时、RAM/PSRAM 和稳定性表格在获得开发板数据前只能保留空表或参考示例。
- 第 10 集扩展的真实记录闭环可以写清代码行为，但三次成功记录、录音回放和故障注入仍必须在真实硬件上完成。
