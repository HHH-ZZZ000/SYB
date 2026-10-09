# 第 2 周：远程采集任务

用户在 Dashboard 点击“采集一次最新数据”后，服务器创建 UUID4 任务；设备领取命令并回报 RUNNING；原有 `sensor_task` 再读一次 QMA6100P；设备带 `request_id` 上传结果。服务器在同一 SQLite 事务中写入新采样并把任务置为 SUCCESS，Web 查询该任务的关联记录。普通周期采集、上传和实时显示继续运行。

```text
Web POST /api/task/create → PENDING
  → ESP32 GET /api/device/command → SENT
  → ESP32 POST /api/device/task/<request_id>/status (RUNNING)
  → sensor_task 收到内部采集请求 → QMA6100P 新读取
  → ESP32 POST /api/upload (带 request_id)
  → SQLite 同一事务 INSERT sensor_data + UPDATE tasks → SUCCESS
  → Web GET /api/task/<request_id> → 显示 result_sample_id 对应的采样
  SENT 超过 30 秒 → TIMEOUT
  RUNNING 超过 60 秒 → TIMEOUT
```

传感器读数失败、内部等待超时或确认上传失败时，设备尝试回报 FAILED。设备不直接设置 SUCCESS；服务器只在收到有效、匹配 RUNNING 任务的新采样并成功提交时设置 SUCCESS。服务器独立检查 SENT / RUNNING 期限，不依赖设备主动回报。

## 数据库与迁移

启动时在事务中将原有版本 3 或 4 升级为版本 5；重复启动不重建数据。原 `sensor_data` 的字段、历史记录、ID 和自增序列保持不变。`tasks` 表字段保持不变：

| 字段 | 说明 |
| --- | --- |
| `id` | 自增主键 |
| `request_id` | 服务器生成的小写标准 UUID4，唯一 |
| `device`、`action` | 设备 ID、`capture_once` |
| `status` | PENDING、SENT、RUNNING、SUCCESS、FAILED、TIMEOUT |
| `created_at`、`sent_at`、`finished_at` | Unix 秒时间戳，尚未发生时为 null |
| `error` | 失败原因，可空 |
| `result_sample_id` | 成功采样的唯一外键，引用 `sensor_data.id` |

`request_id` 无需重复写入 `sensor_data`：由任务的 `result_sample_id` 唯一关联。带任务编号的上传在 `BEGIN IMMEDIATE` 事务内先验证设备和 RUNNING 状态，再插入采样、更新任务；任一操作失败，两项都回滚。相同上传重试返回原采样 ID，不再插入或重复推送；同一 UUID 携带不同采样内容会返回冲突。正式 `server/sensor.db` 只会在正常启动服务时执行迁移；实机验收使用独立 SQLite 文件。

版本 5 新增辅助表 `task_running_times(request_id, started_at)`，用任务 UUID 持久记录首次进入 RUNNING 的 Unix 秒时间。`sent_at` 继续表示首次下发时间，`finished_at` 仍只在终态写入。已有版本 4 的 RUNNING 任务缺少真实起算时间，迁移时从启动时刻给予完整的 60 秒宽限期，避免把可能刚开始执行的任务立即判为超时。

## 自动超时

正式服务启动时创建守护线程 `task_timeout_worker`，启动后立即检查，此后每 5 秒检查一次。SENT 使用 `sent_at`，超过 30 秒转 TIMEOUT；RUNNING 使用辅助表中的 `started_at`，超过 60 秒转 TIMEOUT。两种转换都写入 `finished_at` 与 `error: "task timeout"`，并在事务提交后记录 UUID、原状态、TIMEOUT 和 UTC 时间。重复 RUNNING 回执不会重置计时。

检查在 `BEGIN IMMEDIATE` 事务中只选择 SENT 和 RUNNING。采样提交、设备回执和超时检查的竞争由 SQLite 串行化；SUCCESS、FAILED、TIMEOUT 均不能再被改写。PENDING 没有下发时间，不在本阶段的超时范围。隔离测试实例默认不启动线程，单独验证线程的测试显式使用正式服务启动条件。

## 接口

`POST /api/task/create`，JSON `{"device":"ESP32-S3-EYE","action":"capture_once"}`。成功为 HTTP 201，返回 `{"request_id":"<UUID4>","status":"PENDING"}`。仅此接口把显示名 `ESP32-S3-EYE` 映射到固件 ID `ESP32_S3_EYE`。

`GET /api/device/command?device=ESP32_S3_EYE`，原子领取该设备最新的 PENDING 任务并置为 SENT，返回 `{"request_id":"<UUID4>","command":"capture_once"}`；没有任务时返回 `{"command":"none"}`。已领取的任务不会再次下发；其他设备不能领取。

`POST /api/device/task/<request_id>/status`，JSON `{"device":"ESP32_S3_EYE","status":"RUNNING"}` 或 `{"device":"ESP32_S3_EYE","status":"FAILED","error":"capture_timeout"}`。成功为 HTTP 200，返回 `request_id`、`status`。仅允许任务所属设备报告 RUNNING / FAILED；完全相同的回执可安全重试。不能用此接口直接报告 SUCCESS。

`POST /api/upload` 保留原字段和响应；`request_id` 为可选字段。普通周期上传发送 `"request_id":null`，旧客户端省略该字段也继续有效。远程采集发送任务 UUID4。有效关联上传成功为 HTTP 201，返回原有 `ok`、`id`、`device`，并包含 `request_id`、`status:"SUCCESS"`。

`GET /api/task/<request_id>` 返回任务字段；SUCCESS 时另有 `result` 对象，其 `id` 等于 `result_sample_id`，内容直接来自该条 `sensor_data`。查询不会拿最新的周期采样充当任务结果。Web 每秒查询活动任务，刷新页面后恢复最近任务编号；完成后停止轮询。
任务超时后，原查询接口返回 `status: "TIMEOUT"`、`error: "task timeout"` 和 `finished_at`；现有页面会显示任务超时及原因，无需新增 Web 接口。

输入格式错误为 400，任务不存在为 404，设备不匹配、非法状态迁移或同 UUID 不同采样为 409，不支持的 Content-Type 为 415。原有上传还保留已有请求大小与测试隔离限制。

## 设备实现

`command_task` 独立轮询，优先级 3、栈 8192 字节。领取任务后先用自己的 HTTP client 报告 RUNNING，再把 UUID 放进独立采集请求队列。优先级 5 的原 `sensor_task` 仍是唯一使用 QMA6100P 驱动的任务：收到内部请求后在正常读取路径完成一次新采样，同时保留周期采样队列。命令任务等待对应 UUID 的采集结果，使用独立 HTTP client 上传；失败时尝试回报 FAILED。状态回执和任务上传在网络异常时最多重试 5 次，并复用相同请求内容。原 `uploader_task` 与相机任务不参与命令流程。

## 验证

在项目根目录运行：

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s server -v
node --test tests/test_dashboard.cjs
```

专项测试覆盖状态合法性、设备归属、旧版及 null 上传兼容、提交失败的事务回滚、重复上传幂等、重启后查询和并发重试。浏览器测试覆盖按钮重复点击、任务状态/结果显示、查询失败恢复、刷新后恢复。软件夹具不能替代真实传感器验证。

Phase 4 的隔离测试验证 30/60 秒边界、重复 RUNNING 回执不延期、SUCCESS/FAILED 终态保持、超时后迟到回执及采样被拒绝、版本 4 RUNNING 任务迁移宽限期，以及服务重启后后台线程自动检查。后端完整测试共 69 项、Web 测试共 8 项通过，其中新增的 Web 断言确认 TIMEOUT 与 `task timeout` 正确显示，并停止该任务的轮询。本阶段没有重新烧录或测试硬件。
另在正式版本 3 数据库的副本上完成 3→5 迁移，逐行核对 77,759 条 `sensor_data` 历史记录完全一致；正式数据库文件未被测试写入。
使用 Phase 3 的版本 4 实机测试数据库副本做 4→5 迁移，逐行核对 2,459 条采样及原任务记录不变；SUCCESS 任务仍关联原记录 `#1266`。

### 2026-09-23 实机验收

ESP-IDF 5.4.4 构建通过；备份旧应用后仅向 COM3 的 ESP32-S3 应用分区 `0x10000` 烧录新固件，校验通过。隔离服务与数据库接收真实设备 `192.168.3.14` 的上传。
服务器完整测试 64 项、Web 测试 7 项均通过；驱动源文件及正式 `sensor.db` 的 SHA-256 与修改前一致。

- 网页创建 UUID `8e1178e7-f1ee-4bc6-add8-2eaa325a4fb9`；服务记录 PENDING → SENT → RUNNING → SUCCESS。
- 串口记录领取同一 UUID、RUNNING 确认、内部请求入队、`sensor_task` 新采样、关联上传及 SUCCESS 确认。单调时钟 `queued_us=19358239847`，`sampled_us=19358249199`，证明读取发生在内部请求之后。
- 关联记录为 `sensor_data.id=1266`，X/Y/Z 分别 `-0.03882/0.66626/0.71240 g`；数值与设备上传正文完全一致，任务 `result_sample_id=1266`。网页显示同一 UUID 和记录编号；刷新后仍可查询结果。
- 之后仍观察到大量 `request_id:null` 的真实周期上传，且对应 HTTP 201。该实机测试未注入假采样或更改正式数据库。

### 当前限制

- SENT 表示服务器已提交领取状态。若领取响应丢失，设备收不到命令，现有一次领取规则不会重发。
- 后台检查每 5 秒一次，TIMEOUT 最多会晚于阈值约一个检查周期；服务停机期间不会检查，重启后立即补查。
- 如果 RUNNING 已确认而设备之后失去网络，FAILED 回执也可能发不出去；超过 60 秒后服务器会将该任务置为 TIMEOUT。
