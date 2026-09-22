# 扩展案例 9：语音资源预算与配置选择

> 类型：`FW` ｜ 验证状态：参考值，待实机校准 ｜ 对应微课：[`microcourses/09_audio_perf_tradeoff`](../../microcourses/09_audio_perf_tradeoff/)

## 摘要

微课教会你"测一组"；本扩展把 **3 种语音模式 × 2 种 CPU 频率 = 6 组配置**一次测完，回答产品问题：Memory Pendant 的待机监听该选哪一个？资源预算就是把延迟、内存和稳定性放在一起，用实测数据而不是感觉做选择。

三样工具：

1. **构建矩阵脚本** [`tools/run_matrix.sh`](tools/run_matrix.sh)：一条命令构建任意组合，每组用独立 build 目录和 sdkconfig，互不污染；
2. **日志解析脚本** [`tools/parse_audio_bench.py`](tools/parse_audio_bench.py)：把板上日志中的 `[BENCH] summary` 行提取成 CSV；
3. **频率配置文件** [`configs/cpu160.defaults`](configs/cpu160.defaults) / [`configs/cpu240.defaults`](configs/cpu240.defaults)：唯一差异就是 CPU 频率。

被测代码 100% 复用微课：[`main/CMakeLists.txt`](main/CMakeLists.txt) 直接引用微课的 `main.c` 和 `voice_benchmark.c`，只是把模式选择从"改头文件"升级为"命令行传参"。产出是六组构建产物和（有板时）六份板上日志与 CSV；所有数字必须来自你的实机，仓库里不预置虚构测量结果。

## Quick Start

**预备知识**

- **实验矩阵**：把两个变量（模式 3 个取值 × 频率 2 个取值）系统组合成 6 组，其他一切（IDF 版本、模型、窗口时长、代码）保持相同，六组数据才可比。
- **为什么要独立 build 目录**：ESP-IDF 构建是有状态的，共用目录会产生"旧缓存 + 新配置"混杂的固件，测出的数据不知道对应哪个配置。脚本为每组指定 `build/<mode>_<cpu>/` 并把该组 `sdkconfig` 放进同一目录，六组物理隔离。
- **命令行怎么传进 C 代码**：脚本把模式名翻译成数字 → `idf.py -D BENCH_MODE=2` → CMake 的 `target_compile_definitions` 生成编译期宏 `VOICE_BENCH_MODE=2` → `perf_config.h` 的 `#ifndef` 守卫让命令行值生效。
- **复习**：AFE 是持续运行的音频前端；WakeNet 持续监听唤醒词（待机成本）；MultiNet 唤醒后按需运行（触发成本）；`internal_free`/`psram_free` 是内存余量；`avg_us` 是平均延迟，`max_us` 暴露长尾。详见微课最小案例 9"预备知识"。
- **为什么分开预算**：设备一天里绝大部分时间在待机（只跑 WakeNet），被唤醒后的几秒钟才跑 MultiNet。正确预算是"待机成本 × 待机时长占比 + 触发成本 × 触发频次"，把两个模式的数字直接相加没有意义。

![WakeNet 与 MultiNet 的持续/按需资源关系图（AI 生成示意）](../../docs/assets/ai_generated/wakenet_multinet_layers.png)

> 图：资源预算不能只比较一次函数耗时，还要考虑模型在系统状态中的运行持续时间。具体 avg/min/max、RAM 和 PSRAM 结果必须来自矩阵实验。


**阶段 A：主机构建六组矩阵（无需开发板）**

**第 1 步：进入工程并确认 IDF 环境**

```bash
cd extensions/09_audio_resource_budget
idf.py --version
```

预期输出 `ESP-IDF v5.x.x`；报 `command not found` 先 source IDF 的 `export` 脚本。本扩展的目标芯片是 esp32s3（ESP32-S3-EYE），由 `sdkconfig.defaults` 中的 `CONFIG_IDF_TARGET="esp32s3"` 声明；若构建报目标芯片相关错误，先执行 `idf.py set-target esp32s3`。

**第 2 步：逐组构建（共 6 条命令）**

```bash
./tools/run_matrix.sh vad cpu160
./tools/run_matrix.sh vad cpu240
./tools/run_matrix.sh wakenet cpu160
./tools/run_matrix.sh wakenet cpu240
./tools/run_matrix.sh multinet cpu160
./tools/run_matrix.sh multinet cpu240
```

每条命令创建独立目录 `build/<mode>_<cpu>/`，先 reconfigure 再完整 build。六条跑完后 `ls build/` 应见六个目录，每个里面有 `sdkconfig` 和 `audio_resource_budget.bin`。每组首次约 3～8 分钟（六组不共享缓存，建议留足半小时以上）；报 `Permission denied` 先执行 `chmod +x tools/run_matrix.sh`。

**第 3 步：抽查配置确实不同**

```bash
grep CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ build/vad_cpu160/sdkconfig
grep CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ build/vad_cpu240/sdkconfig
```

应分别显示 `..._160=y` 和 `..._240=y`。这是"矩阵没配错"的最直接证据，实验记录里应保留。

**阶段 B：板上测量（需要 ESP32-S3-EYE）**

**第 4 步：烧录某一组并保存日志**

以 WakeNet + 240 MHz 为例：

```bash
idf.py -B build/wakenet_cpu240 -p <PORT> flash monitor
```

设备启动后自动跑 10 秒基准（无需按键），把**完整原始日志**存为 `wakenet_cpu240.log`。六组各重复一次；每次烧录前核对目录名，启动后核对 `[BENCH] start mode=... cpu=...MHz` 行确认刷对了固件。

**第 5 步：解析日志为 CSV**

```bash
python tools/parse_audio_bench.py wakenet_cpu240.log > wakenet_cpu240.csv
cat wakenet_cpu240.csv
```

预期输出表头加两行数据（`afe_fetch` 一行有真实数字，`multinet_detect` 一行 `count=0`）。若**只有表头**，说明日志里没有 summary（该组无效），回第 4 步查设备是否重启/报错。

**第 6 步：汇总对比并写结论**

把六份 CSV 合并成对比表（建议加列：`internal_free`/`psram_free` 范围、是否出现错误/重启），回答两个问题：待机持续监听（WakeNet）选哪个频率？唤醒后按需识别（MultiNet）对频率敏感吗？结论必须同时引用延迟和稳定性证据。

**没有开发板时**：只能完成阶段 A 的六组构建验证；不得引用或编造任何板上数字。

## 预期现象

主机侧成功时每组都有独立 build 目录和固件，六组 `sdkconfig` 的频率项两两可区分。板上成功日志形如（**格式示例，具体数值以实机为准**）：

```text
I (xxx) lesson09_bench: [BENCH] start mode=WakeNet duration_ms=10000 cpu=240MHz
I (xxx) lesson09_bench: [BENCH] stage=afe_fetch mode=WakeNet elapsed_us=... core=1 internal_free=... psram_free=... vad=0 wake=0
...
I (xxx) lesson09_bench: [BENCH] summary mode=WakeNet stage=afe_fetch count=... avg_us=... min_us=... max_us=...
I (xxx) lesson09_bench: [BENCH] summary mode=WakeNet stage=multinet_detect count=0 avg_us=0 min_us=0 max_us=0
I (xxx) lesson09_bench: done mode=WakeNet
```

判读规则：

- `count=0` 表示该阶段不适用于当前模式（MultiNet 组的 `afe_fetch` 行、VAD/WakeNet 组的 `multinet_detect` 行都是如此），是正常现象；
- 同一模式比较 cpu160 与 cpu240：预期 160 组 `avg_us` 更大（算得慢），但两组内存基线应接近——差异明显说明另有变量没控制住；
- 空表头 CSV、内存持续下降、`feed_error`/`fetch_error`、设备重启都使该组**无效**，保留原始日志排查，不补写数字；
- `[BENCH] start` 行的 `mode=`/`cpu=` 必须与登记的组合一致，不一致说明烧错固件，整组作废重测。

**常见问题排查**

| 现象 | 可能原因 | 解决办法 |
|---|---|---|
| `run_matrix.sh` 报 `Permission denied` | 脚本没有可执行权限 | `chmod +x tools/run_matrix.sh`，或用 `bash tools/run_matrix.sh ...` 运行 |
| 脚本打印 usage 后退出 | 参数拼写错误（如大写 `WakeNet`、`cpu-160`） | 参数是全小写的 `vad/wakenet/multinet` 和 `cpu160/cpu240` |
| 两组构建结果看起来一样 | 用了同一 build 目录或漏传参数 | 核对每条命令的两个参数，用 grep 抽查各组 sdkconfig 的频率项 |
| `reconfigure` 报 CMake 找不到 `main.c` | 微课目录被移动/改名，相对路径失效 | 保持微课工程与本工程的相对位置不变（都在仓库根下） |
| 板上日志 `mode=`/`cpu=` 与预期组合不符 | 烧的是别的组合的固件 | 每组用 `idf.py -B build/<组合> -p <PORT> flash monitor`，烧录前核对目录名 |
| 解析出的 CSV 只有表头 | 日志无 summary 行：设备中途重启、启动失败或日志没存全 | 检查日志末尾有没有 `done mode=`，该组标为无效并重测 |

## 学习目标

- 运行六组构建矩阵，理解每组为什么要独立 build 目录；
- 用解析脚本把 `[BENCH] summary` 日志转成 CSV，并识别无效组；
- 比较平均/最大耗时与内存余量，识别长尾和疑似泄漏；
- 为"待机监听"和"唤醒后识别"分别给出配置选择并说明理由。

## 原理讲解

**`run_matrix.sh` 做了什么？**

脚本只有三十来行，核心逻辑：

```bash
case "$mode" in            # 参数 1：模式名 → 数字
  vad) bench_mode=1 ;; wakenet) bench_mode=2 ;; multinet) bench_mode=3 ;;
  *) echo "mode must be vad, wakenet, or multinet" >&2; exit 2 ;;
esac
case "$cpu_defaults" in    # 参数 2：只接受 cpu160 / cpu240
  cpu160|cpu240) ;;
  *) echo "CPU_DEFAULTS must be cpu160 or cpu240" >&2; exit 2 ;;
esac
build_dir="${project_dir}/build/${mode}_${cpu_defaults}"
export SDKCONFIG_DEFAULTS="${project_dir}/sdkconfig.defaults;${project_dir}/configs/${cpu_defaults}.defaults"
idf.py -C "${project_dir}" -B "${build_dir}" -D "SDKCONFIG=${build_dir}/sdkconfig" \
  -D "SDKCONFIG_DEFAULTS=${SDKCONFIG_DEFAULTS}" -D "BENCH_MODE=${bench_mode}" reconfigure
if [[ -n "$port" ]]; then idf.py -B "${build_dir}" -p "$port" build monitor
else idf.py -B "${build_dir}" build; fi
```

要点：

- 参数非法直接退出码 2，不会构建出配置错误的固件（`set -euo pipefail` 保证任何一步失败都终止）；
- `SDKCONFIG_DEFAULTS` 用分号串两个文件：先应用工程默认（模型、PSRAM、8MB Flash），再叠加频率文件（只覆盖 CPU 频率），后写的覆盖先写的；
- **传第三个参数 PORT 时，脚本只 build + monitor，不自动烧录**——防止把错误组合的固件刷进板子。更稳妥的做法是构建后手动 `idf.py -B build/<组合> -p <PORT> flash monitor`。

两个频率配置文件各只有两行：把对方频率显式 `is not set`、把自己置 `y`，显式互斥避免叠加后打架，保证"唯一变量"。

**`parse_audio_bench.py` 做了什么？**

一个正则匹配 summary 行，把 `mode,stage,count,avg,min,max` 六列写成 CSV 到标准输出；另一个 `ZERO_PATTERN` 专门处理 `count=0` 的"不适用阶段"行，让"不适用"也留下机器可读的记录。**如果日志里一条 summary 都没有（比如设备中途重启），脚本仍输出只有表头的空 CSV**——这时把该组标为无效去查原因，绝不能手工补数字。

**数据从哪里来？**

被测固件与微课完全相同：`benchmark_task` 在 10 秒窗口内逐帧计时并打印 `elapsed_us / core / internal_free / psram_free`，结束打印两行 summary（不适用的一行恒为 `count=0`）。日志格式、错误标记和判读方法回看微课 README 的"预期现象"。

## 整体流程图

```text
MODE(vad/wakenet/multinet) + CPU(cpu160/cpu240)
                      ↓ run_matrix.sh（校验参数 → 独立 SDKCONFIG/SDKCONFIG_DEFAULTS → -D BENCH_MODE）
            独立 build/<mode>_<cpu>/ 固件（6 组互不污染）
                      ↓ 手动烧录 + monitor，保存板上原始日志 <mode>_<cpu>.log
              parse_audio_bench.py <mode>_<cpu>.log
                      ↓
             CSV: mode,stage,count,avg,min,max
                      ↓
     汇总 6 组 CSV + 内存曲线 → 延迟/内存/稳定性对比表 → 配置选择结论
```

## 关键代码解析

**1. `main/CMakeLists.txt`：跨目录复用微课代码**

```cmake
set(BENCH_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../microcourses/09_audio_perf_tradeoff/main)
idf_component_register(
    SRCS "${BENCH_DIR}/main.c" "${BENCH_DIR}/voice_benchmark.c"
    INCLUDE_DIRS "${BENCH_DIR}"
    REQUIRES voice_common esp-sr esp_timer esp_hw_support heap)

if (DEFINED BENCH_MODE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE VOICE_BENCH_MODE=${BENCH_MODE})
endif()
```

本工程 `main/` 下没有任何 .c 源文件——被测代码就是微课那份，从源码层面保证"扩展测的正是微课教的东西"。`BENCH_MODE` 未定义时回落到头文件默认的 VAD 模式，所以不走脚本直接 `idf.py build` 也能构建，只是模式固定。

**2. `run_matrix.sh` 的隔离机制**

三个参数完成隔离：`-B build/<mode>_<cpu>`（构建目录）、`SDKCONFIG=<build目录>/sdkconfig`（配置落盘位置）、`SDKCONFIG_DEFAULTS=工程默认;频率文件`（配置来源叠加）；`-D BENCH_MODE=<1|2|3>` 把模式送进 CMake。完整引用见"原理讲解"。

**3. `parse_audio_bench.py` 的双正则设计**

```python
ZERO_PATTERN = re.compile(
    r"summary mode=(?P<mode>\S+) stage=(?P<stage>\S+) count=(?P<count>0)"
    r"(?: avg_us=0 min_us=0 max_us=0)?"
)
```

主正则先匹配完整 summary 行；匹配不上再试 `count=0` 行（avg/min/max 字段可有可无，兼容截断日志）；都匹配不上的行直接忽略——启动噪声和每帧日志不会混进 CSV。

## 关键文件说明

| 文件/目录 | 职责 | 类型 |
|---|---|---|
| [`tools/run_matrix.sh`](tools/run_matrix.sh) | 六组构建/可选 monitor 编排，参数校验与目录隔离 | 课程脚本 |
| [`tools/parse_audio_bench.py`](tools/parse_audio_bench.py) | `[BENCH] summary` 日志 → CSV（含 count=0 处理） | 课程脚本 |
| [`configs/cpu160.defaults`](configs/cpu160.defaults) / [`configs/cpu240.defaults`](configs/cpu240.defaults) | 唯一的频率差异变量 | 实验配置 |
| [`main/CMakeLists.txt`](main/CMakeLists.txt) / [`main/idf_component.yml`](main/idf_component.yml) | 复用微课基准源码、注入 `BENCH_MODE`；托管依赖 `esp-sr ^2.0.0` | 构建配置 |
| [`CMakeLists.txt`](CMakeLists.txt) / [`sdkconfig.defaults`](sdkconfig.defaults) / [`partitions.csv`](partitions.csv) | 工程名 `audio_resource_budget`；8MB Flash/PSRAM/模型配置；`factory` 2500K + `model` 5168K | 构建配置 |
| [`../../microcourses/09_audio_perf_tradeoff/main/`](../../microcourses/09_audio_perf_tradeoff/main/) | 被测源码（main.c / voice_benchmark.c / perf_config.h） | 共享课程代码 |
| `build/<mode>_<cpu>/`、`<mode>_<cpu>.log` / `.csv` | 构建产物与板上实验记录（自行保存，不提交虚构数据） | 生成物 |

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| 命令行参数 1 | `MODE`（vad/wakenet/multinet） | 选择基准模式，经 `BENCH_MODE` 编译进固件 |
| 命令行参数 2 | `CPU_DEFAULTS`（cpu160/cpu240） | 选择叠加哪个频率配置文件 |
| 命令行参数 3 | `PORT`（可选） | 提供时构建后直接打开 monitor（不自动烧录） |
| [`configs/*.defaults`](configs/) | `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_*` | 改变启动频率和处理耗时，是矩阵的第二个变量 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | SR 模型选项 | 换模型改变内存基线；六组必须用同一份，否则矩阵不可比 |
| 微课 `perf_config.h` | `VOICE_BENCH_DURATION_MS` | 改窗口时长影响所有六组的 `count`，改动需登记 |

## 术语小表

| 术语 | 解释 |
|---|---|
| 矩阵 | 多个独立变量组合形成的实验集合，本案例为 3 模式 × 2 频率 |
| 构建隔离 | 每组实验用独立 build 目录和 sdkconfig，避免配置残留污染 |
| `SDKCONFIG_DEFAULTS` | ESP-IDF 的默认配置叠加机制，多个文件用分号分隔，后者覆盖前者 |
| `avg_us` | 平均处理耗时（微秒） |
| `min_us` / `max_us` | 窗口内最小/最大处理耗时，`max_us` 反映长尾 |
| `count` | 有效样本数；`count=0` 表示该阶段不适用于当前模式 |
| RAM/PSRAM | 内部/外部内存余量指标，对应日志 `internal_free`/`psram_free` |
| 长尾 | 少量明显高于平均值的耗时样本 |
| 泄漏 | 内存余量随时间单调下降、不回升的现象 |
| 持续成本 / 按需成本 | 待机期间一直发生的消耗（WakeNet）/ 触发后短暂发生的消耗（MultiNet） |
| 资源预算 | 按"状态 × 时长 × 单状态消耗"估算系统整体资源需求 |

## 验证清单

- [ ] 六组构建均使用独立 build 目录并成功（`ls build/` 见六个 `<mode>_<cpu>` 目录）；
- [ ] 每组记录模式、CPU、IDF 版本和模型配置（可从各组 `sdkconfig` 摘取）；
- [ ] 抽查至少两组 sdkconfig，确认频率项确实不同；
- [ ] 板上日志原文与解析 CSV 一一对应（每组一个 `.log` + 一个 `.csv`），空摘要组标为无效；
- [ ] 记录平均/最大耗时、RAM、PSRAM、错误和重启情况；
- [ ] 结论同时引用延迟数据和稳定性证据，并区分 WakeNet 持续成本与 MultiNet 按需成本。

## 思考题与拓展挑战

**思考题**

1. 为什么每个组合要使用独立 build 目录？

   **参考答案：**不同 CPU 和模式会改变生成的配置，独立目录避免旧缓存污染当前实验，保证每组固件与登记的配置严格对应、数据可追溯。

2. 为什么最大耗时对交互设备很重要？

   **参考答案：**最大值反映长尾延迟，偶发长尾可能造成超时、漏响应或看门狗问题，平均值说明不了稳定性。唤醒词漏检一次，用户就得再说一遍。

**拓展挑战**

- 为解析 CSV 增加长尾比例和失败原因列（需先定义长尾阈值，例如 `> 2×avg`）；
- 设计一个按"待机时间占比、触发次数、单次耗时"估算日资源预算的表格，用六组实测数据填入两种候选配置做对比；
- 在 `configs/` 下新增第三种配置（如 PSRAM 80M 改 40M），把矩阵扩展为 3 × 3，并评估构建时间成本。

