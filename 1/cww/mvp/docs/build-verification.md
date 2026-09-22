# 构建与运行验证记录

> 原则：**未把未重新编译写成构建通过，不以静态检查代替板上运行证据。** 没有硬件时如实标注"板上验证待硬件"。

## 验证环境

| 项 | 值 |
|---|---|
| 日期 | 2026-08-26 |
| 主机 | macOS |
| ESP-IDF | v5.4.3（`idf.py --version`） |
| Python | 3.11（conda `esp32s3`） |
| PyTorch | 2.11.0 |
| esp-ppq | 1.2.10 |
| onnx / onnxsim | 1.17.0 / 0.4.36 |
| esp-dl | 3.3.9（视觉工程与第 10 集扩展统一） |

## 第 1 集：sin 模型训练

- 训练/验证 loss 和 ONNX 导出：训练脚本已迁移到 microcourses/01_train_sin_model

## 第 2 集：sin 模型量化

- 训练/验证 loss（500 epoch，80/20 划分）：final train loss **0.00247**，final val loss **0.00297**
- 量化前后精度对照（同一份数据 MSE）：float **0.00248** vs quant **0.00357**
- 模型大小对照（.onnx vs .espdl）：**18 244 bytes** vs **7 680 bytes**
- 产物清单：`outputs/sin_model.{pth,onnx,espdl,json,info}`、`loss_curve.png`、`fit_curve.png`、`loss_history.csv` ✅ 均已生成

## 第 3 集：ESP32 sin 模型固件构建

- `idf.py set-target esp32s3`：成功
- `idf.py build`：成功，bin 大小 **0xe97e0 bytes（956 KB）**
- `idf.py size`：
  - Flash code（.text）：**790 508 bytes**
  - DIRAM：**87 742 bytes（25.67%）** — .text 65 799 + .data 12 628 + .bss 8 288
  - Flash data（.rodata）：**86 276 bytes**（含嵌入的 7 680 bytes .espdl 模型）
  - 总镜像大小：**956 266 bytes**
  - App 分区 0x7d0000（8 MB），**88% 空闲**
- esp-dl 实际解析版本：**3.3.9**（`espressif/esp-dl: "^3.1.0"` → commit 12c0616）
- 板上运行（flash monitor）：**板上验证待硬件**

## 第 3 集扩展：SD 卡静态猫狗推理

- 工程：extensions/03_catdog_static_infer
- 工程源码已提供；板上 SD 卡挂载、JPEG 解码和分类结果待硬件验证。

## 第 3 集阶段性作业：LCD 实时猫狗分类

- 工程：extensions/03_live_catdog_assignment
- 已迁移并保留摄像头、LCD、帧缓冲和分类任务代码。
- 实时分类、丢帧、PSRAM 和重复运行审计待硬件验证。

## 第 5～10 集：语音与系统集成

本轮已在 ESP-IDF v5.4.3 下完成以下工程的 `idf.py build` 验证；第 9 集扩展另完成了三种模式 × 两档 CPU 频率的六组独立构建。均未执行烧录和串口采集，因此板上行为仍需使用 ESP32-S3-EYE 验证。

| 工程 | 结果 |
|---|---|
| `microcourses/05_mic_recording` | ✅ 构建通过，约 0.30 MiB，GPIO0 触发 WAV 录音 |
| `microcourses/06_vad_detection` | ✅ 构建通过，约 1.30 MiB，VAD 模型分区可用 |
| `microcourses/07_wakenet_wav` | ✅ 构建通过，约 1.11 MiB，从 SD 卡读取 WAV 输入 |
| `microcourses/08_multinet_command` | ✅ 构建通过，约 1.39 MiB，文本命令配置 |
| `extensions/05_recording_playback_verify` | ✅ 构建通过 |
| `extensions/06_vad_stability_test` | ✅ 构建通过 |
| `extensions/07_wakenet_realtime` | ✅ 构建通过 |
| `extensions/08_command_action_binding` | ✅ 构建通过 |
| `microcourses/09_audio_perf_tradeoff` | ✅ 构建通过，默认 VAD 基准，约 1.42 MiB |
| `extensions/09_audio_resource_budget` | ✅ 六组矩阵固件均构建通过，复用第 9 集基准源码；板上数据待采集 |
| `microcourses/10_system_state_machine` | ✅ 构建通过，约 0.21 MiB |
| `extensions/10_state_machine_test` | ✅ 正常固件和 `REAL_ACTION_SCENARIO=3` 异常固件均构建通过，含时间戳、动作日志和 LCD 状态，约 4.98 MiB，6 MiB factory 分区剩余约 22% |

当前文档链路为：

| 集数 | 工程 | 构建/运行验证 |
|---:|---|---|
| 5 | `microcourses/05_mic_recording` | 板载麦克风、按键触发、约 10 秒录音、文件大小和保存结果 |
| 6 | `microcourses/06_vad_detection` | `SPEECH` / `NOISE` 状态切换 |
| 7 | `microcourses/07_wakenet_wav` | SD 卡 WAV 输入和 WakeNet 唤醒结果 |
| 8 | `microcourses/08_multinet_command` | WakeNet 唤醒、MultiNet 命令编号和超时 |
| 9 | `microcourses/09_audio_perf_tradeoff` | 处理耗时、响应延迟、RAM/PSRAM |
| 9 | `extensions/09_audio_resource_budget` | 六组固件构建完成；平均/最大耗时和资源数据待板上采集 |
| 10 | `microcourses/10_system_state_machine` | 正常状态迁移和异常回退 |
| 10 | `extensions/10_state_machine_test` | 真实预览帧、约 10 秒 WAV、猫狗推理、SD 卡文件、时间戳和 LCD 状态代码已完成；板上数据待采集 |

扩展案例分别验证录音回放、VAD 稳定性、WakeNet 实时麦克风、MultiNet 命令回调、语音资源预算和状态机异常路径。

ESP-SR 例程参考：

- ESP-SR 示例工程。

第 7 集使用 SD 卡中的 WAV 文件作为 WakeNet 算法测试输入，但最终实时路径必须在第 7 集扩展中使用板载麦克风。不得将真实个人语音或测试 WAV 文件提交到仓库。第 10 集扩展的图像模型嵌入固件，记录产物写入 SD 卡；尚未连接开发板时不填写虚构的串口结果。

## 交付检查清单

- [x] `build/`、`managed_components/`、`sdkconfig` 未被 git 跟踪
- [ ] 无 `esp32p4` 残留
- [ ] 无凭据、真实个人照片入库
