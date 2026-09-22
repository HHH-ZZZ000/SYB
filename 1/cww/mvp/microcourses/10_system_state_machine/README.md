# 最小案例 10：系统状态机设计

> 类型：`FW` ｜ 验证状态：参考值，待实机校准 ｜ 后续：[`extensions/10_state_machine_test`](../../extensions/10_state_machine_test/)

## 摘要

前 9 个最小案例攒齐了零件：摄像头、猫狗推理、录音、VAD、WakeNet、MultiNet、性能测量。本集回答最后一个问题——**怎么把零件组织成一个"不会乱"的系统？** 答案是状态机（State Machine）。

本微课在 ESP32-S3-EYE 上实现一个纯逻辑状态机：按键（GPIO0）触发一次**模拟**的记录流程，状态沿"待机 → 监听 → 命令 → 拍照 → 录音 → 推理 → 保存 → 反馈"推进，每条迁移都在串口打印一条可审计日志（如 `[STATE] transition IDLE -> LISTENING event=START accepted=yes`）。

所有动作（拍照、录音、推理、保存）都是模拟的——由 `mock_actions.c` 按编译期选定的场景（正常/录音失败/取消/超时）返回确定性事件。你可以先在零硬件风险下把正常路径和三条异常路径全部跑通；扩展案例 [`extensions/10_state_machine_test`](../../extensions/10_state_machine_test/) 再把动作换成真实摄像头、麦克风、模型和 SD 卡，状态机核心代码一行不改。

## Quick Start

**预备知识**

- **什么是状态机**：像自动售货机——任意时刻只处于一个状态（待机/已投币/出货），事件（投币/按键）推动状态变化，且不是任何事件在任何状态都合法。三要素：状态（当前阶段，只有一个）、事件（输入）、迁移规则表（"状态 X + 事件 Y → 状态 Z"）。
- **为什么不用一个大 loop**：塞满 if 和标志位的大循环，"系统在哪个阶段"散落在一堆 bool 里，异常时清什么、回到哪全靠临场发挥。状态机把当前阶段收敛成一个变量 `state`、规则收敛成一张显式表：可观察（读一个变量就知道在干嘛）、可审计（非法事件统一进 ERROR）、可恢复（回退只有一条 `ERROR → RESET → IDLE` 路径）、可替换（动作换真换假规则表不动）。
- **按键轮询**：`app_main` 每 20 ms 用 `voice_button_pressed()` 查一次 GPIO0，做边沿检测——只有电平从 1（松开）变 0（按下）的那一次返回 true，按住不放只触发一次。模拟流程同步执行，每步间隔 100 ms，方便肉眼跟上日志。


**第 1 步：进入工程目录并确认 IDF 环境**

```bash
cd microcourses/10_system_state_machine
idf.py --version
```

预期输出 `ESP-IDF v5.x.x`；报错则先 source IDF 的 `export` 脚本。

**第 2 步：设置目标芯片**

```bash
idf.py set-target esp32s3
```

按 `sdkconfig.defaults` 生成配置（8MB Flash、OCT PSRAM 80M、CPU 240MHz、自定义分区表）。

**第 3 步：编译**

```bash
idf.py build
```

编译 3 个源文件（`main.c`、`state_machine.c`、`mock_actions.c`）和共享组件 `voice_common`；不含语音模型，首次约 1～2 分钟。

**第 4 步（有开发板时）：烧录并打开监视器**

```bash
idf.py -p <PORT> flash monitor
```

启动后看到 `ready: press GPIO0 to run the state-machine demo`。退出 monitor 按 `Ctrl+]`。没有开发板时只能完成构建验证；状态机是纯逻辑代码，也可在 PC 上单测（见拓展挑战）。

**第 5 步：按一下 GPIO0（板上 BOOT 键）**

触发一轮演示：约 9 条 `[STATE]` 日志 + 若干 `mock action=...` 日志，约 1 秒打完，最后回到 IDLE。可反复按，每按一次完整重放一轮——这就是可重复实验。

**详细步骤：跑完四种场景**

场景由 [`main/state_config.h`](main/state_config.h) 的 `STATE_MACHINE_SCENARIO` 决定，默认正常。**每换一个场景都要重新 `idf.py build` + flash**，然后按一次 GPIO0：

1. **正常（0）**：验证 9 状态全链路，日志是一条不间断的 `accepted=yes` 迁移链，最后 `FEEDBACK -> IDLE`；
2. **录音失败（1）**：改成 `STATE_SCENARIO_FAIL_RECORD`。预期 RECORD 处出现 `mock action=record result=failed`、`[STATE] error RECORD -> ERROR event=ACTION_FAILED accepted=no`，随后 `error_path_reset_to_idle` 和 `[STATE] transition ERROR -> IDLE event=RESET accepted=yes`；
3. **取消（2）**：改成 `STATE_SCENARIO_CANCEL`。预期 COMMAND 处出现 `[STATE] transition COMMAND -> IDLE event=CANCEL accepted=yes`——取消**不经过 ERROR**，也没有 `error_path_reset_to_idle` 日志；
4. **超时（3）**：改成 `STATE_SCENARIO_TIMEOUT`。预期第一步就在 LISTENING 超时：`[STATE] error LISTENING -> ERROR event=TIMEOUT accepted=no`，然后同样走 RESET 回 IDLE。

四份日志各保存一份作为验证证据；做完把场景改回 `STATE_SCENARIO_NORMAL`。

## 预期现象

以下为**日志格式示例，具体时间戳以实机为准**。TAG：`lesson10_state`（状态机）、`lesson10_mock`（模拟动作）。正常场景一次按键的完整输出：

```text
I (xxx) lesson10_state: [STATE] transition IDLE -> LISTENING event=START accepted=yes
I (xxx) lesson10_mock: mock action=wait_wake result=detected
I (xxx) lesson10_state: [STATE] transition LISTENING -> COMMAND event=WAKE_DETECTED accepted=yes
I (xxx) lesson10_mock: mock action=recognize_command result=detected
I (xxx) lesson10_state: [STATE] transition COMMAND -> CAPTURE event=COMMAND_DETECTED accepted=yes
...（CAPTURE/RECORD/INFER/SAVE 各步同格式：mock 一行 + [STATE] transition 一行）...
I (xxx) lesson10_state: [STATE] transition SAVE -> FEEDBACK event=ACTION_DONE accepted=yes
I (xxx) lesson10_mock: mock action=feedback result=done
I (xxx) lesson10_state: [STATE] transition FEEDBACK -> IDLE event=ACTION_DONE accepted=yes
```

录音失败场景（关键片段）：

```text
I (xxx) lesson10_mock: mock action=record result=failed
I (xxx) lesson10_state: [STATE] error RECORD -> ERROR event=ACTION_FAILED accepted=no
I (xxx) lesson10_state: error_path_reset_to_idle
I (xxx) lesson10_state: [STATE] transition ERROR -> IDLE event=RESET accepted=yes
```

取消场景（关键片段）：

```text
I (xxx) lesson10_state: [STATE] transition COMMAND -> IDLE event=CANCEL accepted=yes
```

判读要点：

- 每条 `[STATE]` 行必须包含前状态、后状态、事件、accepted 四要素，缺一说明日志被截断；
- `accepted=no` 只应出现在进入 ERROR 的那一条；ERROR 之后的 RESET 必须是 `accepted=yes`；
- 看到 `UNKNOWN_STATE`/`UNKNOWN_EVENT` 说明枚举越界，是代码 bug 而非场景问题；
- 不要只看"最后回到了 IDLE"就判成功——取消和失败复位也会回 IDLE，必须检查中间迁移链是否完整、有没有意外的 `error` 行。

**常见问题排查**

| 现象 | 可能原因 | 解决办法 |
|---|---|---|
| 按 GPIO0 没有反应 | 按的不是 BOOT 键，或按键 GPIO 配置被改 | 短按板上 BOOT/GPIO0 键，检查 `VOICE_RECORD_BUTTON_GPIO` |
| 改了 `state_config.h` 场景但行为没变 | 忘记重新编译烧录，板上是旧固件 | 每次改场景后完整 `idf.py build` + `flash`，核对特征日志行 |
| 看到 `accepted=no` 以为程序坏了 | 误解：失败迁移本来就返回 false | `accepted=no` 进 ERROR、随后 RESET 成功，恰恰说明错误处理正常 |
| TIMEOUT 场景 mock 打印 `result=detected` 却超时 | mock 说明文字写死，与实际返回事件不一致 | 以 `[STATE]` 行的 `event=TIMEOUT` 为准，这是读日志的已知陷阱 |
| 出现 `UNKNOWN_STATE` / `UNKNOWN_EVENT`，或编译找不到 `voice_common.h` | 枚举值越界（代码被改坏），或共享组件相对路径失效 | 恢复 `state_machine.h` 枚举定义；保持 `components/voice_common` 与 `microcourses/` 相对位置 |

## 学习目标

- 列出本状态机的 9 个状态、8 类事件和全部合法迁移；
- 修改 `main/state_config.h` 运行正常、失败、取消、超时四种场景；
- 读懂迁移日志的每个字段（前状态、后状态、事件、accepted）；
- 解释非法事件为什么进 `ERROR`、取消为什么直接回 `IDLE`、错误回退为什么经过 `RESET`。

## 原理讲解

**状态与事件（`main/state_machine.h`）**

9 个状态：IDLE（待机）、LISTENING（监听唤醒词）、COMMAND（等待命令词）、CAPTURE（拍照）、RECORD（录音）、INFER（推理）、SAVE（保存）、FEEDBACK（反馈）、ERROR（错误）。

8 类事件：START（按键触发）、WAKE_DETECTED、COMMAND_DETECTED、ACTION_DONE（动作成功）、ACTION_FAILED（动作失败）、TIMEOUT、CANCEL、RESET（错误后复位）。`app_state_name()` / `app_event_name()` 把枚举转成日志字符串，越界值返回 `UNKNOWN_STATE` / `UNKNOWN_EVENT`。

**三条特殊规则（与 `state_machine.c` 代码一致）**

1. **CANCEL 优先于一切**：任何状态收到 CANCEL 都直接回 `IDLE` 且 `accepted=yes`——取消是用户的合法意愿，不是错误，**不经过 ERROR**；
2. **RESET 只在 ERROR 和 IDLE 有效**：`ERROR + RESET → IDLE` 是标准恢复路径；`IDLE + RESET` 原地接受（幂等）；其他状态收到 RESET 状态不变、返回 false；
3. **非法事件兜底进 ERROR**：规则表没匹配的组合（如 IDLE 收到 ACTION_DONE）统一 `*state = ERROR; return false;`——宁可停下报错，也不带着不明状态继续跑。注意失败类迁移虽然 `accepted=no`，状态**确实**变成了 ERROR，日志会如实打印如 `RECORD -> ERROR`。

**状态迁移图（与代码一致）**

```text
  主链（事件均为 accepted=yes）：
  IDLE ─START→ LISTENING ─WAKE_DETECTED→ COMMAND ─COMMAND_DETECTED→ CAPTURE
    ─ACTION_DONE→ RECORD ─ACTION_DONE→ INFER ─ACTION_DONE→ SAVE
    ─ACTION_DONE→ FEEDBACK ─ACTION_DONE→ IDLE

  CANCEL：任意状态 ─CANCEL→ IDLE（accepted=yes，不经过 ERROR）
  失败：LISTENING/COMMAND ─TIMEOUT→ ERROR；RECORD ─TIMEOUT或ACTION_FAILED→ ERROR；
        CAPTURE/INFER/SAVE ─ACTION_FAILED→ ERROR；非法事件 ─→ ERROR（均 accepted=no）
  恢复：ERROR ─RESET→ IDLE（accepted=yes）；IDLE ─RESET→ IDLE（幂等）
```

**谁产生事件？——`mock_action_event()`**

微课里没有真实硬件，事件由 `mock_actions.c` 按"当前状态 + 场景宏"确定性给出：每个状态返回它的成功事件，除了场景指定的那一步。例如 `STATE_SCENARIO_FAIL_RECORD` 时，RECORD 返回 `ACTION_FAILED`，其余照常成功。四种场景在 [`main/state_config.h`](main/state_config.h) 里编号：NORMAL=0、FAIL_RECORD=1、CANCEL=2、TIMEOUT=3。

**读日志陷阱**：mock 的说明文字是写死的——TIMEOUT 场景下 LISTENING 仍会打印 `mock action=wait_wake result=detected`，但随后返回的事件其实是 TIMEOUT。永远以 `[STATE]` 行的 `event=` 和 `accepted=` 为准，mock 文字只是提示"该做哪个动作了"。

**迁移日志与主循环**

所有事件都经 `dispatch_event()` 这一个入口进入状态机，打印 `[STATE] transition/error 前状态 -> 后状态 event=事件名 accepted=yes/no`——串口日志因此是系统行为的完整审计记录。按键后 `run_demo()` 先派发 START，再循环"延时 100 ms → 问 mock 要事件 → 派发"，直到回到 `IDLE`（正常/取消）或掉进 `ERROR`；若是 ERROR，打印 `error_path_reset_to_idle` 并派发 RESET 收尾。一次按键 = 一轮完整可重复的实验。

![Memory Pendant 系统状态机示意图（AI 生成示意）](../../docs/assets/ai_generated/system_state_machine_overview.png)

> 图：状态机把正常路径和失败回退路径放在同一张图中。图中状态名称用于帮助阅读，合法事件仍以 `main/state_machine.*` 为准。

## 整体流程图

```text
GPIO0 按下（边沿检测）→ run_demo(): dispatch START → IDLE -> LISTENING
      ↓ 循环（每步间隔 100 ms）：mock_action_event(当前状态) 按场景返回事件
      ↓ dispatch_event → [STATE] 日志
正常：LISTENING → COMMAND → CAPTURE → RECORD → INFER → SAVE → FEEDBACK → IDLE（循环退出）
取消：COMMAND 收到 CANCEL → IDLE（accepted=yes，循环退出，无 ERROR）
失败/超时：对应状态 → ERROR（accepted=no）
      ↓ error_path_reset_to_idle → dispatch RESET → ERROR -> IDLE
```

## 关键代码解析

**1. 纯逻辑核心：`state_machine_step()`（`main/state_machine.c`）**

```c
bool state_machine_step(app_state_t *state, app_event_t event)
{
    if (!state || *state > APP_STATE_ERROR || event > APP_EVENT_RESET) return false; /* 防御 */
    if (event == APP_EVENT_CANCEL) { *state = APP_STATE_IDLE; return true; }  /* 取消：任意状态回待机 */
    if (*state == APP_STATE_ERROR && event == APP_EVENT_RESET) { *state = APP_STATE_IDLE; return true; } /* ERROR 唯一出口 */
    if (*state == APP_STATE_IDLE && event == APP_EVENT_RESET) return true;    /* 幂等接受 */
    switch (*state) { /* 各状态的成功/失败分支见迁移图，如 RECORD+ACTION_DONE→INFER */ }
    *state = APP_STATE_ERROR;   /* 兜底：非法事件一律进 ERROR */
    return false;
}
```

这个函数不碰任何硬件——没有 GPIO、没有日志、没有延时，输入状态+事件，输出新状态+是否接受。纯函数意味着可以脱离 ESP32 在 PC 上单测，也意味着扩展案例换真实动作时它一行不用改。

**2. 一轮演示：`run_demo()`（`main/main.c`）**

所有事件都经 `dispatch_event()` 一个入口进入状态机：记住旧状态 → 调 `state_machine_step()` → 打印 `[STATE] transition/error 前 -> 后 event=... accepted=...`，一条日志四个信息，串口记录就是完整审计日志。`run_demo()` 则是驱动一轮演示的外壳：

```c
static void run_demo(void)
{
    app_state_t state = APP_STATE_IDLE;
    dispatch_event(&state, APP_EVENT_START);            /* 按键 → START */
    while (state != APP_STATE_IDLE && state != APP_STATE_ERROR) {
        vTaskDelay(pdMS_TO_TICKS(100));                 /* 每步间隔 100 ms，肉眼可读 */
        dispatch_event(&state, mock_action_event(state)); /* 问模拟动作要下一个事件 */
    }
    if (state == APP_STATE_ERROR) {
        ESP_LOGI(TAG, "error_path_reset_to_idle");
        dispatch_event(&state, APP_EVENT_RESET);        /* 统一恢复路径 */
    }
}
```

循环同时盯住两个终点：取消场景走 IDLE 退出，失败/超时场景走 ERROR 分支补一次 RESET。`mock_action_event()` 的每个 case 返回什么事件完全由编译期 `STATE_MACHINE_SCENARIO` 决定，同一固件行为 100% 可重复——这就是"确定性场景"。

## 关键文件说明

| 文件 | 职责 | 类型 |
|---|---|---|
| [`main/state_machine.h`](main/state_machine.h) / [`state_machine.c`](main/state_machine.c) | 9 状态/8 事件枚举、名字函数、迁移规则表（纯逻辑，无硬件依赖） | 课程代码 |
| [`main/mock_actions.c`](main/mock_actions.c) / [`mock_actions.h`](main/mock_actions.h) / [`state_config.h`](main/state_config.h) | 按场景返回确定性事件的模拟动作；场景编号 0～3 与 `STATE_MACHINE_SCENARIO` 开关（带 `#ifndef` 守卫） | 课程代码 / 实验配置 |
| [`main/main.c`](main/main.c) | 按键轮询、`dispatch_event` 日志、`run_demo` 主循环 | 课程代码 |
| [`main/CMakeLists.txt`](main/CMakeLists.txt) / [`CMakeLists.txt`](CMakeLists.txt) | 注册源文件；工程名 `system_state_machine`，引入共享组件目录 | 构建配置 |
| [`sdkconfig.defaults`](sdkconfig.defaults) / [`partitions.csv`](partitions.csv) | esp32s3、8MB Flash、PSRAM、CPU 240MHz；`factory` 2500K + `model` 5168K（本课不用模型分区） | 实验/构建配置 |
| [`../../components/voice_common/`](../../components/voice_common/) | `voice_button_init()` / `voice_button_pressed()`（GPIO0 边沿检测） | 共享课程代码 |

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| [`main/state_config.h`](main/state_config.h) | `STATE_MACHINE_SCENARIO` | 选择正常(0)、录音失败(1)、取消(2)、超时(3)四种确定性演示 |
| [`main/main.c`](main/main.c) | `pdMS_TO_TICKS(100)` / `pdMS_TO_TICKS(20)` | 前者是模拟动作间的可观察间隔，后者是按键轮询周期 |
| [`main/mock_actions.c`](main/mock_actions.c) | 各状态返回的事件 | 改变模拟路径（如让 INFER 失败），修改后应补迁移日志证据 |
| [`main/state_machine.c`](main/state_machine.c) | switch 规则 | 改变合法迁移本身，任何改动应同步更新 README 迁移图 |

## 术语小表

| 术语 | 解释 |
|---|---|
| 状态（State） | 系统当前所处的阶段，任意时刻只有一个，用 `app_state_t` 表示 |
| 事件（Event） | 推动状态变化的输入或动作结果，用 `app_event_t` 表示 |
| 迁移（Transition） | 从一个状态到另一个状态的变化，由"当前状态 + 事件"唯一决定 |
| 状态机 | 用状态集合、事件集合和迁移规则表描述系统行为的模型 |
| `accepted` | 当前事件是否被状态机接受；`no` 表示非法或失败迁移 |
| 非法事件 | 当前状态下规则表未定义的事件，统一进入 `ERROR` |
| 回退（恢复） | 失败后经 `ERROR → RESET → IDLE` 清理并回到安全状态的过程 |
| 幂等 | 重复执行结果不变，如 `IDLE + RESET` 原地接受 |
| mock（模拟） | 用确定性假动作替代真实硬件，以便可重复地测试逻辑 |
| 场景（Scenario） | 编译期选定的一组 mock 行为（正常/失败/取消/超时） |
| 边沿检测 | 只在电平"变化的那一次"返回真，避免长按重复触发 |
| 审计日志 | 记录每次迁移前后状态和事件的日志，可事后复盘 |

## 验证清单

- [ ] 正常路径覆盖所有主要状态（IDLE→LISTENING→COMMAND→CAPTURE→RECORD→INFER→SAVE→FEEDBACK→IDLE）；
- [ ] 失败、超时、取消三种场景至少各运行一次并保存日志；
- [ ] 每条日志包含前状态、后状态、事件和 accepted 四要素；
- [ ] 失败/超时路径最终经过 `RESET` 回到 `IDLE`，取消路径直接回 `IDLE` 不经过 ERROR；
- [ ] 模拟动作与真实动作的边界已记录（mock 只产生事件，不碰硬件）；
- [ ] 同一场景重复按键两轮，日志完全一致（确定性验证）。

## 思考题与拓展挑战

**思考题**

1. 为什么错误路径不能直接跳回 `IDLE`？

   **参考答案：**显式经过 `ERROR` 和 `RESET` 才能保留失败原因、执行清理并验证恢复逻辑。直接跳回 IDLE 会把"失败"伪装成"正常结束"，日志上无法区分。

2. 为什么状态机核心适合与具体硬件动作分离？

   **参考答案：**`state_machine_step()` 是纯函数，规则可以先用模拟事件测试；真实硬件只需提供成功/失败事件。这样容易复现错误，也能一眼定位是"动作失败"还是"迁移规则错误"。

**拓展挑战**

- 为每个状态补充进入/退出时间（用 `esp_timer_get_time()` 打点），形成一次完整的时延报告；
- 在不改状态枚举的前提下增加"按键取消"入口（提示：在 run_demo 循环里轮询第二次按键并派发 CANCEL），或把 `state_machine.c` 拷到 PC 上对迁移表做穷举单测（9 状态 × 8 事件 = 72 种组合），验证每条与 README 迁移图一致。

