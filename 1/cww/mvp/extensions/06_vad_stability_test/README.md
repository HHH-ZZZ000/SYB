# 扩展案例 6：VAD 语音片段与稳定性测试

> 类型：`FW` ｜ 验证状态：参考值，待实机校准 ｜ 对应微课：[`microcourses/06_vad_detection`](../../microcourses/06_vad_detection/)

## 摘要

微课 06 让你"看到 VAD 会切换状态"；本扩展案例回答一个工程问题：**VAD 切得稳不稳、准不准？** 代码把每次状态变化扩展为可量化的统计：语音片段数（`speech_events`）、状态变化次数（`state_changes`）、每段语音时长（`segment_duration_ms`），并每 30 秒（`TEST_WINDOW_MS=30000`）输出一行 `summary` 摘要。

你要做的实验：在**安静、正常说话、环境噪声**三种场景下各跑至少一个完整 30 秒窗口，用摘要数据比较 VAD 阈值（`vad_min_speech_ms` / `vad_min_noise_ms` / `vad_mode`）对**误触发、漏检、边界抖动**的影响。AFE/VAD 链路与微课完全一致（同一套默认阈值，保证对照可比），全程**不保存原始音频、不提交真实个人语音**。

## Quick Start

**预备知识**

- **VAD 与 AFE feed/fetch（复习）**：VAD 输出二值状态（说话=SPEECH，安静/噪声=NOISE）；`feed_task`（CPU0）不断把麦克风 PCM 喂进 AFE，`detect_task`（CPU1）用 `fetch()` 取结果里的 `vad_state`。初始化流程与微课 06 完全相同，不熟悉的先读 [`microcourses/06_vad_detection/README.md`](../../microcourses/06_vad_detection/README.md) 的预备知识。
- **三个 VAD 参数（复习）**：`vad_min_speech_ms=128`（持续超过 128 ms 才算 SPEECH，抑制短脉冲）；`vad_min_noise_ms=1000`（持续安静超过 1 秒才切回 NOISE，抑制说话间隙抖动）；`vad_mode=VAD_MODE_1`（灵敏度模式，ESP-SR 枚举 0=Normal、1=Aggressive，越高判定越严格）。本扩展默认值与微课一致——**对照实验的前提是除被测变量外其他条件都相同**。
- **误触发 / 漏检 / 抖动怎么用数据定义**：误触发=没有目标语音却进入 SPEECH（安静/噪声窗口里 `speech_events > 0`）；漏检=说了 N 句但 `speech_events` 少于 N；抖动=SPEECH/NOISE 短时间反复切换（`state_changes` 明显大于一段语音应有的 2 次变化）。理想值：安静窗口 `speech_events=0, state_changes≈0`（开机首次打印贡献 1 次）；说 5 句的窗口 `speech_events=5, state_changes≈10～11`。
- **FreeRTOS tick 与时长测量**：代码用 `xTaskGetTickCount()` 记时刻、`pdTICKS_TO_MS()` 换算毫秒。本工程 `CONFIG_FREERTOS_HZ=100`，1 tick = 10 ms，所以 `segment_duration_ms` 的**分辨率是 10 ms**——读数 620 ms 意味着真实时长在 610～630 ms 之间。分析片段长短够用，但不是毫秒级精确测量。
- **为什么要"统计窗口"**：误触发率 = 误触发次数 ÷ 观察时长，必须有固定观察时长做分母。本工程把分母定为 30 秒，每满 30 秒输出一行 `summary` 并清零计数器，你只需按窗口抄数、重复实验、汇总成表。


以下命令在电脑上执行。先确认已安装 ESP-IDF（课程验证版本 v5.4.3）并导出环境。

**第 1 步：进入工程目录并确认环境**

```bash
cd extensions/06_vad_stability_test
idf.py --version
```

工程通过 `EXTRA_COMPONENT_DIRS` 引入共享组件，须在仓库原位构建。版本预期 `ESP-IDF v5.4.3`（或其他 v5.x）；报 `command not found` 先执行 IDF 的 `export.sh`。

**第 2 步：设置目标芯片**

```bash
idf.py set-target esp32s3
```

[`sdkconfig.defaults`](sdkconfig.defaults) 与微课 06 完全一致：esp32s3、8MB Flash、自定义分区、`CONFIG_SR_VADN_VADNET1_MEDIUM=y`（VAD 模型）、`CONFIG_SR_WN_WN9_HIESP=y`（本案例不运行但随配置打包）、八线 PSRAM@80MHz、CPU 240MHz。

**第 3 步：编译**

```bash
idf.py build
```

编译固件并生成 `model` 分区镜像（打包 SR 模型）。首次会下载 `espressif/esp-sr`（体积大），耗时 5～15 分钟，增量几十秒。预期末尾 `Project build complete`。没有开发板只能做构建验证；**稳定性数据必须来自实机**。

**第 4 步：找串口**

macOS `ls /dev/cu*`（以 `cu` 开头的设备）；Linux `ls /dev/ttyUSB* /dev/ttyACM*`；Windows 设备管理器 `COMx`。

**第 5 步：烧录并监视**

```bash
idf.py -p <PORT> flash monitor
```

烧录应用 + 模型分区约 2～4 分钟。复位后预期先看到 `scenario=run quiet/speech/noise separately`，随后是状态与摘要日志。退出监视器 `Ctrl + ]`。

**第 6 步：按场景做实验（核心环节，约 15～30 分钟）**

准备记录表（场景/环境描述/阈值版本/窗口序号/speech_events/state_changes/各片段时长/备注）。每个窗口之间**建议按 RST 复位**保证窗口与场景对齐；连续跑的话务必标注场景切换发生在窗口第几秒，跨界窗口标记为无效或拆分处理。

1. **安静场景**：房间尽量安静（记录背景，如"实验室夜间，无空调"）。按 RST 对齐窗口，静坐 30 秒等一行 `summary`，重复 2～3 个窗口。预期 `speech_events=0`（首窗 `state_changes` 可能为 1，来自开机首次打印）；任何 `speech_events>0` 记为误触发，并记下当时是否有突发声音（关门、键盘）；
2. **说话场景**：距麦克风 10～30 cm，正常音量说若干句（建议每窗口固定 5 句、每句 2～3 秒、句间停 2 秒以上；内容用公开文本或数数，**不要录入真实个人语音**）。按 RST 复位后开说，记录 `summary`。核对：`speech_events` 是否等于句数（少了=漏检）；`segment_duration_ms` 是否与句长相仿（明显偏长=句间停顿不足 1 秒被 `min_noise_ms=1000` 合并，属预期行为，可作分析点）；
3. **噪声场景**：制造稳定环境噪声（播放非人声音乐/白噪声、开风扇，声源距板约 1 m 并记录）。按 RST 复位，跑 2～3 个窗口，记录 `speech_events`（误触发）和 `state_changes`（抖动程度）；
4. （可选）阈值对照：一次只改一个参数（见"配置说明"），每种取值重复三场景各至少 1 个窗口，记入同一张表。

## 预期现象

正常日志序列如下（前缀 `I (毫秒) ext06_vad:`；**格式示例，具体数值以实机为准**）：

```text
I (xxx) ext06_vad: scenario=run quiet/speech/noise separately
I (xxx) ext06_vad: state=NOISE                    # 开机首次打印（计入本窗口 state_changes）
...（安静约 30 秒）...
I (xxx) ext06_vad: summary window_ms=30000 speech_events=0 state_changes=1
...（复位后开始说话场景，说了 3 句）...
I (xxx) ext06_vad: state=SPEECH
I (xxx) ext06_vad: segment_duration_ms=2140
I (xxx) ext06_vad: state=NOISE
...（第 2、3 句同样三行）...
I (xxx) ext06_vad: summary window_ms=30000 speech_events=3 state_changes=7
```

读法要点：`segment_duration_ms` 出现在 `state=NOISE` **之前**，分辨率 10 ms（tick=100Hz）；上例 `state_changes=7` = 开机首次打印 1 次 + 3 段语音 × 2 次跳变；安静窗口理想值 `speech_events=0`，噪声窗口 `speech_events` 每 +1 就是一次误触发，`state_changes` 远大于 `2×speech_events+1` 说明存在抖动；句间停顿不足 1 秒时两句话会被合并成一个更长的片段——不是 bug，是 `vad_min_noise_ms=1000` 的设计行为，应记入分析。

失败路径：`fetch()` 失败时打印 `E ... fetch_error` 后检测任务退出，**不再有任何 summary 输出**，该窗口必须整体标记为无效（数据截断），排查模型分区、内存后重测，不能拿半窗数据凑数。启动即崩溃重启时优先检查是否用 `idf.py flash` 烧入了 `model` 分区。

**常见问题排查**

| # | 现象 | 可能原因 | 解决办法 |
|---|---|---|---|
| 1 | 启动即崩溃/重启，或从不出现 `scenario=...` | `model` 分区未烧入、模型加载失败、PSRAM 配置不符 | 用 `idf.py -p <PORT> flash monitor` 整片烧录；重新 `set-target esp32s3` 后重烧 |
| 2 | `fetch_error` 后不再有任何输出（含 summary） | AFE fetch 失败，检测任务已退出，窗口数据作废 | 记录日志、复位重测；持续复现则重烧固件 |
| 3 | 安静窗口 `speech_events` 总是 >0 | 突发声（空调、键盘、脚步）或阈值太灵敏 | 记录每次误触发的时刻和声源；换更安静环境；对比增大 `vad_min_speech_ms` 或更高 `vad_mode` |
| 4 | 说话窗口 `speech_events` 少于实际句数（漏检） | 音量小/距离远、句子短于 128ms、`vad_mode` 过严 | 靠近麦克风提高音量；核对每句实际时长；降低 `vad_mode` 对照重测 |
| 5 | 说了 5 句只有 2 个片段、片段特别长 | 句间停顿不足 1 秒，被 `vad_min_noise_ms=1000` 合并 | 属设计行为：句间停 ≥2 秒，或减小阈值并在记录表注明 |
| 6 | `segment_duration_ms` 总是 10 的倍数；summary 比秒表略晚 | tick 分辨率 10ms；`fetch()` 阻塞使窗口检查最多延后一帧 | 均为正常现象；以 summary 行为窗口边界记录数据 |

## 学习目标

- 设计三种可重复、可描述的 VAD 测试场景（安静/说话/噪声）；
- 从串口日志读取并记录状态变化、片段时长和 30 秒窗口摘要；
- 用数据解释 `min_speech_ms` 与 `min_noise_ms` 各自的作用和代价；
- 理解 FreeRTOS tick 如何换算成片段时长，明白单次命中为什么不能代表误触发率。

## 原理讲解

**在微课代码上加了四样东西**

新增逻辑全部在检测任务里（`feed_task` 和 AFE 初始化与微课逐行一致，仅任务名为 `vad_test`、TAG 为 `ext06_vad`）：**计数器**（`speech_events` 本窗口进入 SPEECH 的次数、`state_changes` 本窗口跳变总次数，含开机首次打印）；**片段计时**（进入 SPEECH 记起始 tick，切回 NOISE 时打印 `segment_duration_ms=`）；**30 秒统计窗口**（每轮循环检查是否到期，到期打印 `summary` 并清零计数、重置窗口）；**场景提示**（启动打印 `scenario=run quiet/speech/noise separately`，提醒三种场景分开跑）。

**日志顺序与窗口对齐（做实验前必看）**

一段完整语音在日志里的顺序是（不要记反）：`state=SPEECH` → `segment_duration_ms=...` → `state=NOISE`——片段时长行在 NOISE **之前**，描述刚结束的那段语音。`summary` 的检查在阻塞的 fetch 循环里，所以摘要行最多比"整 30 秒"晚一个 fetch 帧出现，属正常现象。

计数器每 30 秒自动清零，但**程序不知道你什么时候换了场景**。推荐操作规程：摆好场景 → 按板上 RST 复位让窗口从 0 开始 → 等 `summary` 出现并记录 → 同场景再重复 1～2 个窗口取平均 → 换场景重来。比较阈值影响时，保持场景、距离、音量不变，**一次只改一个参数**（如 `vad_min_noise_ms`），每个取值跑同样多的窗口填进对照表；改了代码要重新 `idf.py build && idf.py -p <PORT> flash monitor`。

![VAD 语音与噪声波形示意图（AI 生成示意）](../../docs/assets/ai_generated/vad_waveform_concept.png)

> 图：扩展案例要在安静、说话和环境噪声下观察状态边界。该图只解释概念，真实片段和误触发统计必须来自实验日志。

## 整体流程图

```text
安静 / 说话 / 噪声 三种场景（人工布置，分开测试）
        ↓ 板载麦克风 → voice_read_samples()
feed_task（CPU0）→ feed() → AFE(VadNet, 阈值128/1000, VAD_MODE_1)
        ↓ fetch()
detect_task（CPU1）：状态跳变 → state_changes++ / speech_events++ / 片段计时
        ↓ 跳回 NOISE 时打印 segment_duration_ms=...（分辨率 10ms）
        ↓ 每满 30 秒打印 summary window_ms=30000 speech_events=... state_changes=...（计数清零，窗口重置）
```

## 关键代码解析

以下片段摘自 [`main/main.c`](main/main.c) 真实代码，注释为教学补充。`feed_task` 与 AFE 初始化（阈值 128/1000、`VAD_MODE_1`、绑核、栈 8192、优先级 5）与微课 06 逐行相同，此处重点解析新增的统计逻辑。全局常量：`#define TEST_WINDOW_MS 30000`（统计窗口 30 秒）。

**1. `detect_task`：状态跳变与片段计时**

```c
int state = result->vad_state == VAD_SPEECH;            // 1=语音, 0=非语音
if (state != previous) {              // ---- 只在跳变时统计和打印（previous 初值 -1）----
    state_changes++;                  // 任何跳变都计数
    if (state) {                      // 跳入 SPEECH：新片段开始
        speech_events++; speech_start = xTaskGetTickCount();
    } else if (speech_start != 0) {   // 跳回 NOISE：上一片段结束
        ESP_LOGI(TAG, "segment_duration_ms=%u",
                 (unsigned)pdTICKS_TO_MS(xTaskGetTickCount() - speech_start));
        speech_start = 0;             // 清零，防止重复计片段
    }
    ESP_LOGI(TAG, "state=%s", state ? "SPEECH" : "NOISE");  // 状态行在片段时长之后
    previous = state;
}
```

细节：`speech_start != 0` 保证只有经历过 SPEECH 才打印片段时长；跨窗口的片段（SPEECH 在窗口 A 开始、NOISE 在窗口 B 结束）`speech_events` 计入 A、时长打印在 B，汇总时注意归属。

**2. `detect_task`：30 秒窗口摘要**

```c
// 每轮 fetch 循环都检查一次窗口是否到期
if (xTaskGetTickCount() - window_start >= pdMS_TO_TICKS(TEST_WINDOW_MS)) {
    ESP_LOGI(TAG, "summary window_ms=%d speech_events=%d state_changes=%d",
             TEST_WINDOW_MS, speech_events, state_changes);
    speech_events = 0; state_changes = 0;   // 计数清零
    window_start = xTaskGetTickCount();     // 下一个窗口从现在开始
}
```

**3. `app_main` 与微课的差异**

```c
ESP_LOGI(TAG, "scenario=run quiet/speech/noise separately");   // 提醒分场景测试
xTaskCreatePinnedToCore(feed_task, "afe_feed", 8192, data, 5, NULL, 0);   // 采集：CPU0
xTaskCreatePinnedToCore(detect_task, "vad_test", 8192, data, 5, NULL, 1); // 检测+统计：CPU1
```

其余（`voice_audio_init()` → `esp_srmodel_init("model")` → `afe_config_init` → 设三个 VAD 参数 → 建 AFE 实例）与微课 06 完全一致，其中 `config->vad_mode = VAD_MODE_1` 按 ESP-SR 头文件枚举为 Aggressive（越高越严格）。

## 关键文件说明

| 文件 | 职责 | 类型 |
|---|---|---|
| [`main/main.c`](main/main.c) | feed/detect 双任务、片段计时、30 秒窗口统计 | 课程代码 |
| [`main/CMakeLists.txt`](main/CMakeLists.txt)、[`main/idf_component.yml`](main/idf_component.yml) | 声明 `voice_common`、`esp-sr` 依赖 | 构建配置 |
| [`CMakeLists.txt`](CMakeLists.txt)、[`partitions.csv`](partitions.csv)、[`sdkconfig.defaults`](sdkconfig.defaults) | 引入共享组件；`factory` + `model` 5168K 分区；与微课 06 相同的模型、PSRAM 和目标配置 | 构建配置 |
| [`../../components/voice_common/voice_common.c`](../../components/voice_common/voice_common.c) | 板载 I2S 音频输入、输入格式串 | 共享组件 |
| `managed_components/espressif__esp-sr/` | ESP-SR 组件与头文件 | 第三方/生成物 |
| 实验记录表 | 场景、环境描述、阈值版本、每窗口统计与结论 | **学生提交物**（只含统计数据，不含音频） |

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| [`main/main.c`](main/main.c) | `TEST_WINDOW_MS=30000` | 窗口越长统计越平滑，但每次实验耗时增加 |
| [`main/main.c`](main/main.c) | `vad_min_speech_ms=128` | 增大→短语音更难触发（漏检↑、误触发↓）；减小→反之 |
| [`main/main.c`](main/main.c) | `vad_min_noise_ms=1000` | 增大→句间停顿被合并、片段变长、抖动↓但结束延迟↑；减小→片段碎、抖动↑ |
| [`main/main.c`](main/main.c) | `vad_mode=VAD_MODE_1` | 0=Normal 最易触发，数值越高越严格；改后三场景必须全部重测 |
| [`sdkconfig.defaults`](sdkconfig.defaults)、生成的 `sdkconfig` | `CONFIG_SR_*` 模型选项、`CONFIG_FREERTOS_HZ=100` | 换模型=换被测对象，需重烧并注明版本；HZ 决定 tick 分辨率（10ms）即时长测量精度 |

实验纪律：**每次实验只改一个变量**，并在记录表里写明当次固件的参数组合或版本号，否则数据不可比。

## 术语小表

| 术语 | 解释 |
|---|---|
| 误触发 | 没有目标语音却进入 SPEECH；安静/噪声窗口用 `speech_events` 计数 |
| 漏检 | 有目标语音却没进入 SPEECH；对比实际句数与 `speech_events` |
| 抖动 | SPEECH/NOISE 短时间反复切换；`state_changes` 超出 `2×speech_events+1` 的部分 |
| 语音片段 | 一次进入 SPEECH 到切回 NOISE 的区间，时长由 `segment_duration_ms` 给出 |
| 统计窗口 / `summary` 行 | 汇总事件的固定时段（30 秒）；每窗口结束打印的摘要，打印后计数清零 |
| FreeRTOS tick / `pdTICKS_TO_MS` | 系统时基（`CONFIG_FREERTOS_HZ=100` 时 1 tick=10ms）；tick 换算毫秒的宏 |
| AFE / feed / fetch | ESP-SR 音频前端；喂入 PCM / 取出处理结果（含 `vad_state`） |
| `vad_min_speech_ms` | 判定语音的最短持续时间（默认 128ms） |
| `vad_min_noise_ms` | 切回静音的最短安静时间（默认 1000ms），决定句间停顿是否被合并 |
| `vad_mode` | 灵敏度模式，0=Normal，数值越高越严格（本工程用 VAD_MODE_1=Aggressive） |
| 单变量对照 / 无效窗口 | 每次只改一个参数保证可比；`fetch_error` 或跨场景的窗口不计入统计 |

## 验证清单

- [ ] 安静、说话、噪声三场景各有明确的时长、距离、声源和环境描述，每种场景至少保存一个完整 30 秒窗口的 `summary` 行（建议 2～3 个）；
- [ ] 记录每窗口的 `speech_events`、`state_changes` 和各 `segment_duration_ms`，并标注误触发/漏检/抖动观察；
- [ ] 阈值对照每次只改一个参数，记录表注明固件参数组合或版本号；
- [ ] `fetch_error` 或跨场景窗口被标记为无效，未混入统计；
- [ ] 记录目标板、IDF 版本（`idf.py --version`）、SR 模型配置（`CONFIG_SR_VADN_VADNET1_MEDIUM`）；
- [ ] 实验记录表只含统计数据与文字描述，**不保存、不提交任何真实个人语音或原始音频**。

**讲师参考基线**

```text
窗口：30 s（TEST_WINDOW_MS=30000）；tick 分辨率 10 ms（CONFIG_FREERTOS_HZ=100）
默认阈值：vad_min_speech_ms=128、vad_min_noise_ms=1000、vad_mode=VAD_MODE_1（与微课 06 一致）
理想读数：安静窗口 speech_events=0（首窗 state_changes 可为 1）；N 句话窗口 speech_events=N、
          state_changes≈2N(+1)、片段时长≈句长（句间停<1s 会合并）；数值必须以实机复测为准
隐私：测试语音用公开文本/数数，只提交统计摘要
```

## 思考题与拓展挑战

**思考题**

1. 为什么稳定性测试要把噪声单独作为场景？

   **参考答案：**噪声（尤其含人声成分或节奏性的）可能与语音特征相似，只在安静环境测试会严重低估误触发率。Memory Pendant 随身佩戴，真实环境几乎永远不是完全安静的。

2. 为什么要记录 `state_changes`，而不只记录 `speech_events`？

   **参考答案：**`speech_events` 看不出边界质量。同样 3 次语音事件，`state_changes=7` 说明每段干净利落，`=25` 说明片段内部在反复抖动——事件数相同、稳定性天差地别。

3. 一段语音正好跨过 30 秒窗口边界，两个指标分别记在哪个窗口？

   **参考答案：**`speech_events` 在进入 SPEECH 时计数，记入前一个窗口；`segment_duration_ms` 在切回 NOISE 时打印，出现在后一个窗口。直接拼接会错位，需按日志时间轴人工归属。

**拓展挑战**

- 设计阈值二维对照表（`vad_min_speech_ms` × `vad_min_noise_ms` 各 3 档），每格用相同场景、相同长度的窗口，用统计数据填表并给出推荐组合；
- 只保存统计摘要（不保存音频），给 `detect_task` 增加片段时长的最小/最大/平均值统计并输出到 summary 行；
- 用 GPIO0 按键（参考扩展 05 的 `voice_button_pressed()`）手动标记场景切换时刻打印 `scenario_mark=...`，或对比 `VAD_MODE_0` 与 `VAD_MODE_1` 在同一噪声场景下的误触发率，验证"模式越高越严格"的方向性。

