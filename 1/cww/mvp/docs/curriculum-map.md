# 课程地图

课程按视觉模块 → 语音模块 → 系统集成组织。

## 三层组织

| 层级 | 目录 | 定位 |
|---|---|---|
| 微课最小案例 | microcourses/ | 每集一个能够运行并产生直观现象的最小闭环 |
| 扩展案例 | extensions/ | 真实数据、硬件、异常处理、性能分析和阶段性作业 |
| 综合案例 | capstone/memory_pendant/ | 视觉与语音统一为 Memory Pendant 闭环 |

## 前四集视觉链路

| 集 | 微课最小案例 | 扩展案例或阶段性作业 | 状态 |
|---:|---|---|---|
| 1 | 训练 sin 模型 | 训练猫狗分类模型 | ✅ |
| 2 | 量化 sin 模型 | 量化猫狗分类模型 | ✅ |
| 3 | ESP32 加载 sin 模型并推理 | SD 卡静态猫狗分类；LCD 实时猫狗分类阶段性作业 | ✅/待硬件 |
| 4 | 认识 `infer`、`core`、`cpu`，切换推理 CPU，调整 CPU 频率 | ①测量 FPS、延迟、帧年龄、丢帧、帧缓冲、任务优先级和系统稳定性；②复用卡顿基线生成 Chrome Trace JSON 并用 Perfetto 查看阶段时间线 | ✅ |

对应目录：

- microcourses/01_train_sin_model/
- microcourses/02_quantize_sin_model/
- microcourses/03_run_sin_model/
- extensions/01_train_catdog_model/
- extensions/02_quantize_catdog_model/
- extensions/03_catdog_static_infer/
- extensions/03_live_catdog_assignment/
- microcourses/04_live_infer_tuning/
- extensions/04_live_infer_optimized/
- extensions/04_live_infer_trace/

语音与系统集成对应目录：

- microcourses/05_mic_recording/ 与 extensions/05_recording_playback_verify/
- microcourses/06_vad_detection/ 与 extensions/06_vad_stability_test/
- microcourses/07_wakenet_wav/ 与 extensions/07_wakenet_realtime/
- microcourses/08_multinet_command/ 与 extensions/08_command_action_binding/
- microcourses/09_audio_perf_tradeoff/ 与 extensions/09_audio_resource_budget/
- microcourses/10_system_state_machine/ 与 extensions/10_state_machine_test/

## 语音与系统集成

| 集 | 微课 | 扩展案例 |
|---:|---|---|
| 5 | 麦克风基本使用及按键录音 | 录音保存与回放验证 |
| 6 | VAD 语音活动检测 | VAD 语音片段与稳定性测试 |
| 7 | WakeNet WAV 唤醒词检测 | WakeNet 板载麦克风实时语音 |
| 8 | MultiNet 命令识别 | 自定义命令词与应用回调 |
| 9 | 语音性能指标与权衡 | 语音资源预算与配置选择 |
| 10 | 系统状态机设计 | 状态机测试 |

第 3 集阶段性作业复用上一门课的 LCD 摄像头实时预览；第 4 集微课以其运行日志为基础，先认识推理耗时、运行核心和 CPU 频率，再由扩展案例测量 FPS 并分析任务调度和系统稳定性。`extensions/04_live_infer_trace/` 保留微课的 CPU0/160 MHz 卡顿基线，增加 Chrome Trace JSON 和 Perfetto 阶段时间线，用于观察卡顿发生时预览与推理的时间关系。
第 5～8 集依次建立录音、VAD、WakeNet 和 MultiNet 能力；第 7 集从 SD 卡 WAV 文件开始理解 WakeNet，扩展案例再切换到板载麦克风实时语音；第 9 集分析语音链路资源，第 10 集微课建立可重复的状态机骨架，扩展案例接入真实摄像头、录音、猫狗推理和 SD 卡保存。FreeRTOS 任务和队列作为实现手段贯穿案例，不再单独设置 FreeRTOS 微课。
