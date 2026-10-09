# 按需获取一张环境图像（第 7 周）

## 使用

在项目根目录运行 `run.bat`，打开原 Web 的“智能助手”，选择设备后输入：

- 看一下现在的环境
- 拍一张照片
- 获取当前画面
- 拍一张现在的环境图

语音识别的文字仍通过同一个 `AssistantSession.send()`。本周没有修改 ASR/TTS。
图片、设备、设备拍摄时间、任务编号显示在原有对话滚动框内，点击图片可查看大图。
设备未选择时先澄清，明确离线时不创建任务。不会自动重发创建请求。

## 原有机制中的新任务

仍使用 `POST /api/task/create`、`GET /api/device/command`、设备 RUNNING/FAILED 回执和
`GET /api/task/<task_id>`，只增加动作 `image_capture`。

| 名称 | 含义 |
| --- | --- |
| 助手 `request_id` | 第 6 周交互 UUID，仍由 AssistantSession 管理取消、替代和播报所有权 |
| `interaction_request_id` | 创建图像任务时记录上述交互 UUID，直接 API 调用可为空 |
| 设备 `task_id` | 旧接口/数据库字段仍叫 `request_id`；不是助手交互 UUID |
| `image_record_id` | 本次 JPEG 入库记录 ID，对应 tasks.result_image_id |

ESP32 在本次任务已确认 RUNNING 后调用现有 OV2640 驱动。丢弃 DMA 时间早于本次
请求的缓存帧，复制本次 JPEG 后归还帧缓冲。网络重试只重传同一图片和时间，不重复拍照。
上传为 `POST /api/device/task/<task_id>/image`，二进制 `image/jpeg`，携带
`X-Device-ID` 和 `X-Capture-Time-Ms`。照片和任务成功状态在同一事务关联。

界面状态沿用现有 waiting/success/error/cancelled，另有图像状态
waiting/capturing/success/unavailable/invalid/failed；取消后由原有请求隔离阻止迟到结果展示或播报。
后台任务可能继续完成并保存原图，但不会重新激活取消的交互。

设备拍摄时间来自帧的 DMA 单调时钟，映射到设备已同步的墙上时钟。原 `/api/time`
只有整秒精度，因此校验允许 2 秒误差；时间不是服务器收到文件时重新编造的拍摄时间。
前后端共同校验任务、设备、记录 ID 和时间；不读取“最新图片”来完成任务。

## 有效性和保留

唯一新增依赖是 Pillow（在 requirements.txt 中）：校验非空、512 B–256 KiB、JPEG 起止标记、
尺寸边界，以及实际解码。保存 SHA-256，读取结果/文件时验证文件仍存在且校验一致。
不判断镜头遮挡，不分析画面内容。

图片默认在 `server/images/<task_id>.jpg`，元数据在现有 SQLite 的 `image_records` 表。
每台设备保留最近 20 张，另保护最近生成或读取的图片 10 分钟；保留窗口内可能超过 20 张。
既有任务超时工作线程会顺带执行清理。仅删除到期文件，保留原任务、时间和记录元数据，
过期访问返回 410；不会删除正在执行的任务结果。目录已经加入 `.gitignore`。

数据库由 v5 事务迁移至 v6，保留旧任务编号、采样记录及 RUNNING 起始时间。
本次迁移前的本地备份在 `.qa/week7-before/sensor.db`；不要用旧备份覆盖新产生的数据。

为避免后台持续采集，默认不启动旧 MJPEG 预览连接。原预览实现保留，仅在显式设置
服务端环境变量 `IMU_CAMERA_PREVIEW=1` 后启用。按需图像任务不依赖此开关，不复用视频缓存。
固件没有消费者时释放摄像头资源，QMA6100P 总线和采集任务保持运行。

## 定向验证记录（2026-09-29）

- COM3 已重新编译、烧录当前 ESP32-S3 固件；串口检测 OV2640、8 MiB PSRAM。
- 阶段一独立真实帧 320×240、3526 B，Pillow 完整解码并查看；旧流不提供设备拍摄时间，
  仅记录收到帧的真实时间窗口。新任务已提供设备帧时间。
- 真实任务 `070671fe-a10a-4429-982a-5687d6c3725f`：HTTP 201，图片 1、3230 B，
  从创建响应到读到并解码结果约 1.094 秒；IMU 记录 259395 → 259402，仍在线。
- 助手交互 `a544ec91-8098-41f7-84f9-c70bfef232d9` →
  图像任务 `2d089a47-0ef3-43ef-9bb4-31161e0c4071` → 图片 2，浏览器实际显示。
- 通过原有串口 camera-off 验证真实设备禁用路径，任务返回 camera_unavailable，没有旧图结果；
  随后 camera-on 恢复。这不等同于物理断开摄像头排线测试。
- 真实取消任务 `e67c82c1-a96e-457b-933b-d4477edc3a07` 的迟到图片 3 正常保存，
  原卡片保持 cancelled 且没有图片，没有覆盖后续已有数据查询。
- 暂停设备周期上传、等待原在线阈值后，图像创建接口约 0.0125 秒返回离线；
  随后恢复上传。USB/WiFi 仍连接，并非拔线测试。
- 原 IMU 助手采集仍成功，任务 `258b0424-e702-46af-a3b3-8cc1c4ca2d2b`，记录 261251。
- 图片对话框仍为原有限高度和原生滚动链；框内滚动与上下边界传递均做浏览器验证。

隔离软件测试使用生成的测试 JPEG 和临时数据库，不写入真实采集库：

```powershell
cd server
../.venv/Scripts/python.exe -m unittest test_images test_tasks test_capture test_assistant test_timeout -q
cd ..
node --test tests/test_assistant_images.mjs tests/test_assistant_requests.mjs tests/test_assistant.mjs
```

覆盖：成功关联、摄像头不可用、离线不建任务、损坏/过大/过旧图片、错误设备、IMU 记录不能完成
图像任务、重复上传幂等、存储文件损坏、保留保护、迁移不丢记录，以及旧图/迟到结果/TTS 隔离。
损坏输入与关联故障为隔离测试；没有人为损坏真实设备文件。
真实麦克风/TTS 听感、物理拔线、摄像头硬件损坏、实体触控板尚未在本次验证。

## 本次修改清单

- 固件：`device/main/main.c`、`device/main/camera_monitor.c`、`device/main/camera_monitor.h`。
- 后端：`server/app.py`、`server/assistant.py`、`server/database.py`、`server/tasks.py`、新增 `server/images.py`。
- 助手前端：`web/services/assistantTools.js`、`web/services/assistantSession.js`、`web/pages/Assistant.js`、`web/assistant.css`。
- 定向测试：新增 `server/test_images.py`、`tests/test_assistant_images.mjs`；更新迁移断言 `server/test_tasks.py`、`server/test_timeout.py`。
- 启动与存储配置：`server/requirements.txt`、`run.bat`、`.gitignore`；新增本文 `server/IMAGES.md`。

2026-09-30 收尾检查：后端仍监听 `0.0.0.0:5000`，设备当时已被原在线逻辑判为离线。
直接请求图像任务返回 HTTP 409 / device_offline，图像任务数量未增加，证据在
`.qa/week7-current-offline.json`。未检查离线的物理原因，也未重新拍摄；上面的真实硬件通过记录属于 9 月 29 日。
