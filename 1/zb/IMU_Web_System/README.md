# 智能传感监控平台

ESP32-S3-EYE 读取真实 QMA6100P 三轴加速度，并采集 OV2640 摄像头画面；通过局域网接入 Flask，传感器记录保存到 SQLite，中文工业监控网页显示数值、曲线、历史记录和实时视频。沿用原有 HTML/CSS/JavaScript 与 Canvas，不依赖外部字体或 CDN。

## 当前交付状态（2026-09-18）

本次继续工作核对的是 `D:\SYB\2\zb\IMU_Web_System`。已完成三轴采集、真实视频、中文 Dashboard 和 Product Design 调整；本轮补齐新版页面连接真实硬件的验收与文档，未重写前后端或重新烧录固件。

| 需求 | 当前状态 | 验证依据 |
| --- | --- | --- |
| QMA6100P → Wi-Fi → HTTP → SQLite → WebSocket → 网页 | 已完成 | 本轮 109 条串口 HTTP 201 的 JSON 与对应数据库记录逐字段一致 |
| OV2640 实时视频、独立在线状态、实测 FPS | 已完成 | 本轮一分钟收到 1,479 帧，网页显示真实 320×240 视频 |
| 中文工业界面、XYZ/MAG、历史列表 | 已完成 | 新版页面在线检查，读数与入库总数持续更新 |
| 30/60/120 秒窗口、冻结与恢复 | 已完成 | 本轮使用真实数据操作，冻结时曲线保持不变、采集继续 |
| 1920×1080、1440px、Mobile 响应式 | 已完成 | 本轮在线截图和 DOM 尺寸检查，无页面横向溢出 |
| 断线重连、离线提示、摄像头与三轴互不阻塞 | 已完成 | 2026-09-16 实机故障测试；本轮复验服务启动后的真实上传和视频恢复 |
| 隔离测试工具 | 已完成 | 独立数据库与端口；本轮相关自动测试通过，未向正式库注入模拟数据 |
| 真实陀螺仪扩展 | 仅预留接口 | 当前硬件没有陀螺仪，正式库三个 gyro 列全部为 NULL；接入后的驱动和实机验收另行进行 |

新版界面分为顶部连接状态、设备摘要、实时测量/趋势/摄像头三栏和历史记录。窄屏改为单列；历史表格在自身容器横向滚动。服务器连接详情可展开，历史总数采用服务器的累计样本数，曲线保持原有真实数据处理流程。设计规范见 `design.md`。

## 数据来源与系统结构

- 传感器链路：QMA6100P → ESP32-S3-EYE → Wi-Fi / HTTP POST → Flask → SQLite → WebSocket / 网页。
- 视频链路：OV2640 → ESP32-S3-EYE 原生 JPEG / MJPEG → Flask 同源视频代理 → 网页。视频不写入传感器数据库。
- QMA6100P 只有三轴加速度。当前正式固件只上传真实 `acc_x / acc_y / acc_z`，单位 **g**，包含重力；合加速度由真实 XYZ 计算，静止时约为 1g。
- `gyro_x / gyro_y / gyro_z` 仅为未来真实陀螺仪扩展预留，单位约定 **rad/s**。当前没有陀螺仪，三个字段为 `NULL`，网页显示“陀螺仪模块未连接”。不得用随机数或默认零值填充。
- 数据采样时间 `timestamp` 为北京时间 `YYYY-MM-DD HH:MM:SS`；`received_at` 是服务器接收时间。在线状态和曲线横轴依据接收时间，超过 **10 秒**没有成功入库的新数据即离线。
- 设备采样与上传目标周期均为 **100 毫秒**；网络请求耗时会影响实际频率。网页只追加真实入库记录，重复请求、断网和等待期间都不产生采样点。网络故障后发送新的实时样本，不缓存补传旧样本。
- 摄像头配置为 **320×240、原生 JPEG、双 PSRAM 缓冲**，帧率目标 15～25FPS，实际结果应以测量为准。相机状态根据最近收到的真实帧单独判断。

## 硬件与工程目录

硬件为 ESP32-S3-EYE、板载 QMA6100P、OV2640、8MB Flash 和 8MB Octal PSRAM，使用数据 USB 线连接电脑。本机开发板串口此前为 `COM3`，重新插拔后以设备管理器为准。

| 路径 | 用途 |
| --- | --- |
| `device/main/main.c` | QMA 读取任务、Wi-Fi 自动重连、局域网校时和真实 HTTP 上传 |
| `device/main/qma6100p.c/.h` | 已验证的 QMA6100P 驱动：±2g、4096 LSB/g、传感器输出频率 100Hz |
| `device/main/camera_monitor.c/.h` | 实物摄像头识别、独立视频服务、故障重试与帧统计 |
| `device/main/idf_component.yml` | 固定官方 esp32-camera 2.1.3 组件 |
| `device/sdkconfig.defaults`、`device/partitions.csv` | ESP32-S3、Octal PSRAM 和应用分区配置 |
| `device/configure.py` | 生成忽略提交的本机 Wi-Fi 配置，不输出密码 |
| `server/app.py`、`server/database.py` | API、校验、SQLite 事务和版本迁移 |
| `server/camera.py`、`server/telemetry.py` | 单路真实视频上游缓存、同源转发和实时消息 |
| `server/sensor.db` | 正式数据库，包含历史真实记录，不要删除 |
| `web/index.html`、`web/style.css`、`web/app.js` | 中文工业界面、真实曲线与视频显示 |
| `design.md` | 工业视觉、布局、交互与状态规范 |
| `test_client.py` | 独立软件测试工具，只能向自己的隔离实例发送模拟数据 |
| `run.bat` | Windows 服务器启动入口 |

QMA 的 I²C 地址为 `0x12`（驱动也探测 `0x13`）；SDA 为 GPIO4、SCL 为 GPIO5。OV2640 的 SCCB 复用这条现有总线，禁止重复创建或删除总线。摄像头引脚：XCLK=15、PCLK=13、VSYNC=6、HREF=7、D0～D7=11/9/8/10/12/18/17/16。不要使用 ESP32-CAM 的引脚表。

摄像头取帧、发送和初始化均在独立任务中执行。摄像头初始化失败、没有 PSRAM、视频客户端断开时，三轴任务继续运行。初始化/释放设备句柄通过互斥保护共享 I²C；若物理硬件将共享总线拉死，仍需排查硬件连接。

## Windows 启动服务器

需要 Python 3.10+。双击项目中的 `run.bat`，或在 PowerShell 执行：

```powershell
cd D:\SYB\2\zb\IMU_Web_System
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
.\.venv\Scripts\python.exe server\app.py
```

本机访问 <http://127.0.0.1:5000>；同一局域网其他设备访问 `http://电脑IPv4:5000`。服务器监听 `0.0.0.0:5000`，保持窗口打开，不要同时启动两个实例。安装依赖后可在无公网的局域网运行。网页断开后会自动重试，服务恢复后重新同步数据库历史。

依赖为 Flask、Flask-Sock 和 simple-websocket。当前部署面向受信任的课程局域网，使用单个 Flask 进程；实时缓存与视频上游由该进程共享。不要直接改为多进程部署后假定进程内广播仍可互通。

## Wi-Fi 与摄像头配置

ESP32-S3 只能连接 **2.4GHz** Wi-Fi。手机热点若只提供 5GHz，请切换到 2.4GHz 或开启最大兼容性。电脑可通过同一局域网的其他频段接入，但设备间必须可以互访。校园网、访客网的客户端隔离可能阻断连接。

用 `ipconfig` 查电脑的局域网 IPv4。设备上传地址必须是电脑地址，不能是 `127.0.0.1`、`localhost`、`0.0.0.0` 或开发板自身地址。网络切换后重新配置实际 IP；可用路由器 DHCP 地址保留减少变动。

```powershell
.\.venv\Scripts\python.exe device\configure.py --windows-profile "已保存的Wi-Fi配置名称" --server http://电脑IPv4:5000
```

配置名称使用 `netsh wlan show interfaces` 中的 Profile，不一定等于 Windows 网络连接显示名称。也可以使用 `--ssid "热点名称"`，在交互提示中输入密码。密码只写入 `device/main/config.local.h`，该文件已被忽略提交。不要把此文件或包含凭据的固件二进制公开分享。

Flask 默认从真实设备成功上传的来源地址发现摄像头，连接 `http://开发板IPv4:81/stream`。网页始终访问同源 `/api/camera`。特殊情况下可在启动服务器前指定可信局域网地址：

```powershell
$env:IMU_CAMERA_URL = 'http://开发板IPv4:81/stream'
.\.venv\Scripts\python.exe server\app.py
```

Windows 防火墙需允许当前受信任网络上的 Python TCP 5000 入站；电脑需能访问开发板 TCP 81。视频复用一条上游连接，多个网页共享最新真实帧；浏览器不直接连接开发板。摄像头离线时显示离线提示并自动重连，不循环播放旧画面。

## ESP-IDF 构建和烧录

本工程使用 ESP-IDF **5.4.x**，当前本机安装为 5.4.4。先生成本机 Wi-Fi 配置，再执行：

```powershell
. 'D:\AI\esp\Espressif\frameworks\esp-idf-v5.4.4\export.ps1'
cd D:\SYB\2\zb\IMU_Web_System\device
python "$env:IDF_PATH\tools\idf.py" build
python "$env:IDF_PATH\tools\idf.py" -p COM3 flash
python "$env:IDF_PATH\tools\idf.py" -p COM3 monitor
```

第一次构建需要联网下载固定的官方摄像头组件。`sdkconfig.defaults` 配置 Octal PSRAM 80MHz；缺失 PSRAM 时继续运行三轴路径。应用分区为 4MiB，保留原 NVS、PHY 和应用起始偏移，不执行整片擦除。

串口识别与验收标记包括：

- `IDENTITY_OK sensor=QMA6100P`：检测到真实加速度计。
- `IDENTITY_OK sensor=OV2640` 与 `CAMERA_READY`：实际摄像头标识与首个真实 JPEG 帧。
- `WIFI_CONNECTED`、`CLOCK_SYNC_OK`：设备获得地址并通过 Flask 校时。
- `HTTP_OK status=201`：本条真实上传已由服务器接受并返回记录 ID。
- `STREAM_STATS`：实测视频帧数、帧率、流量与剩余内存。

USB 控制命令：`pause` / `resume` 只暂停或恢复上传；`wifi-reconnect` 测试断开后自动恢复；`camera-off` / `camera-on` 单独停止或恢复真实摄像头，用于验证视频故障不影响三轴上传。命令不生成测试数据。串口监视器与烧录工具不能同时占用 COM3。

## API 与数据库

| 接口 | 功能 |
| --- | --- |
| `POST /api/upload` | 校验并保存一条真实数据，成功返回 201 和 ID |
| `GET /api/latest` | 最新值、总采样数量、服务器时间、10秒在线状态 |
| `GET /api/history?limit=2000&after_id=记录ID` | 有界增量历史；省略游标时返回最近记录 |
| `GET /api/time` | 局域网校时，返回 Unix 秒 |
| `GET /api/status` | 设备状态与独立摄像头状态、实测帧率/最后帧时间 |
| `GET /api/camera` | 实际 MJPEG 视频；相机不可用时返回 503 |
| `WS /ws/telemetry` | 初始快照、成功入库的新记录和心跳；重连后通过历史接口补齐 |

三轴上传仍使用 `device`、`sensor="QMA6100P"`、`acc_x`、`acc_y`、`acc_z`、`timestamp`，原有设备格式保持兼容。可选 `gyro_x/y/z` 省略或为 null 时保存 SQL NULL；只有真实陀螺仪扩展接入后才能提供完整、有限数值的三元组，不能混用加速度的 ±2g 校验范围。布尔值、非法日期、非有限值、错误传感器、未知字段会被拒绝；错误请求不刷新在线状态。

数据库结构版本 3：`id, device, sensor, acc_x, acc_y, acc_z, timestamp, received_at, gyro_x, gyro_y, gyro_z`。已知版本2的三轴数据库在事务中添加三个可空列，原记录、时间和 ID 不变；未知非空旧结构停止自动迁移，保留数据等待检查。迁移前应使用 SQLite backup 制作一致性备份，不能在运行时只复制主文件而遗漏 WAL。

网页的实时与历史缓存覆盖 120秒×10Hz，按真实记录 ID 去重。冻结只冻结曲线，设备状态和数值继续更新。页面隐藏时减少实时请求与视频负担，恢复可见后重新同步。

## 隔离软件测试

```powershell
cd D:\SYB\2\zb\IMU_Web_System
.\.venv\Scripts\python.exe -m unittest discover -s server -v
.\.venv\Scripts\python.exe test_client.py --samples 20 --interval 0.1 --verify
```

`test_client.py` 明确标记为“隔离测试工具 / 模拟数据”，创建独立 `.qa/test-client/.../sensor-test.db` 和自己拥有的本机端口，禁止正式端口5000。正式服务器拒绝其测试标记。测试实例也不连接正式摄像头、不共享正式实时广播。软件测试不能替代真实硬件或真实视频验收。

前端连接恢复测试使用 Node.js 自带测试工具，无额外依赖：

```powershell
node --test tests/test_dashboard.cjs
```

测试直接执行网页脚本，覆盖浏览器不支持 WebSocket、创建连接时报错后的轮询与重试，以及页面隐藏/恢复。测试不访问网络、不生成传感器测量值，也不读写正式数据库。浏览器不能建立实时推送时，网页仍通过增量轮询更新；支持 WebSocket 但暂时创建失败时，以最长 15 秒的退避间隔继续尝试。

## 完整验收方法

1. 启动服务器和开发板，核对真实型号、PSRAM、Wi-Fi、HTTP 201 与数据库新记录。
2. 缓慢倾斜或翻转开发板，确认三轴、合加速度和曲线同步变化；静止时合加速度约1g。
3. 遮挡、移动摄像头前的物体，确认网页为真实连续画面；同时测量视频帧率和真实上传频率。
4. 分别测试上传暂停、摄像头停止、Wi-Fi 断开、服务器重启；确认独立状态和自动恢复，历史数据不丢失。
5. 检查30/60/120秒窗口、冻结/恢复、历史列表、桌面和手机布局。
6. 测量 Flask 进程 CPU、API 响应时间、视频流量及持续入库，记录环境与测量时段，不用配置值代替实测结果。

硬件参考：[ESP32-S3-EYE 官方板卡说明](https://github.com/espressif/esp-bsp/blob/master/bsp/esp32_s3_eye/README.md)、[官方摄像头组件](https://github.com/espressif/esp32-camera/tree/v2.1.3)。

## 2026-09-16 实机验收结果

已在当前项目目录 `D:\SYB\2\zb\IMU_Web_System` 完成编译、COM3 烧录和实际联调。串口确认 QMA6100P 地址 `0x12`、ID `0x90`；OV2640 地址 `0x30`、PID `0x26`；8MiB PSRAM 正常。用户已实际倾斜开发板并遮挡或移动镜头前物体，确认网页三轴、曲线和视频同步变化。

正式链路已验证：**QMA6100P → ESP32-S3-EYE → 2.4GHz Wi-Fi → HTTP 201 → Flask → SQLite → WebSocket → 中文网页**；OV2640 的真实 MJPEG 通过 Flask 同源代理显示。当前固件不发送任何 gyro 数值，数据库预留列全部为 NULL。

在同时显示视频、实时推送和写入数据库的 60.10 秒测量中：

| 项目 | 实测结果 |
| --- | --- |
| 真实三轴入库频率 | 8.20 次/秒，新增 493 条 |
| WebSocket 推送 | 493 条，编号连续、有序、无重复 |
| 视频 | 320×240，收到 1,465 帧，平均 24.37 帧/秒 |
| 视频 JPEG 数据量 | 约 65.2 kB/s，不含协议开销 |
| 入库接收时间到本机 WebSocket 收到数据 | 平均 5.10ms，P95 6.73ms |
| 本机状态 API 响应 | 平均 9.48ms，P95 21.85ms |
| Flask 进程 CPU | 单核口径 6.84%；本机 24 逻辑核总量口径 0.285% |
| 电脑到开发板 ICMP 往返 | 20 次，平均 4ms，范围 2–13ms，无丢包 |

这些延迟分别描述本机推送、状态接口和局域网往返，不是摄像头从曝光到屏幕显示的完整延迟。刚连接网络时曾出现帧率和上传频率波动；上述结果来自连接稳定后的实际测量，不能视为所有网络环境下的固定保证。

已通过的故障与界面检查：

- 摄像头关闭：网页隐藏旧画面并显示摄像头离线，12 秒内三轴继续入库 99 条；摄像头开启后自动恢复。
- 上传暂停：10 秒后设备离线、读数标记过期，视频保持在线；恢复上传后自动上线。
- Wi-Fi 断开重连：串口确认真实断开事件，约 4 秒后重新获得地址，上传和视频恢复。
- 服务器停止与重启：网页显示服务器异常，恢复后自动重连、补齐历史、恢复视频；重启前 5,317 条记录均保留，SQLite 完整性检查为 `ok`。
- 30/60/120 秒窗口、冻结和恢复均可用；冻结时曲线采样数固定为 959，入库总数从 4,058 增至 4,163。
- 实际 CSS 视口 1920×1080 三栏显示、360×800 手机单列显示，无页面横向溢出；历史表格仅在自身容器内横向滚动。正常运行时浏览器未报告页面脚本错误。

后端 33 项自动测试通过。另运行 `test_client.py --samples 20 --interval 0.1 --verify`，在独立端口和 `.qa/test-client/.../sensor-test.db` 中通过输入校验、入库、离线、恢复及重启持久化检查；模拟数据未进入正式数据库。

升级前 2,582 条原始记录逐字段校验一致。实机链路核验时，3,662 条串口成功上传的 JSON 与正式数据库字段全部匹配，最新 API 数据也与对应数据库记录一致。

本轮串口记录覆盖最终固件启动后的 691 秒（约 11.5 分钟，包含主动故障测试），未发现固件 panic 或任务看门狗触发。验收结束后已释放 COM3；串口工具关闭后的 3 秒仍新增 26 条真实记录，设备与摄像头均在线。更长时间的稳定性仍需按实际部署环境继续观察。

本轮修复了首次 GET 校时时清理不存在的 Content-Type 请求头导致 `ESP_ERR_NOT_FOUND` 的问题，并将摄像头 SCCB 配置改为组件实际支持的 `CONFIG_SCCB_CLK_FREQ=100000`。项目搬迁后的构建缓存已归档并重新生成。

本机验收证据位于忽略提交的 `.qa/acceptance-20260916/`：`backend-tests.log`、`device-flash-http-fix.log`、`serial-live.log`、`database-preservation.json`、`performance.json`、`recovery-*.json`、`restart-result.json`、`end-to-end.json` 和 `lan-ping.log`。其中串口记录来自真实硬件，性能脚本只读取 GET 与 WebSocket，未生成正式数据。该目录及固件二进制仅供本机调试，分享源码时应排除。

## 2026-09-18 新版页面真实硬件复验

本轮发现服务器未运行，启动原有服务后，开发板自动恢复真实上传，摄像头也恢复在线。没有改动网络配置、固件、Flask、SQLite 结构、WebSocket 或视频传输代码。12 个受保护后端/固件文件的 SHA-256 与设计调整前基线一致。

在约 60.06 秒的连续观察中：

| 指标 | 本轮实测 |
| --- | --- |
| 正式入库频率 | 8.98 次/秒，记录 ID 从 71,998 增至 72,537 |
| WebSocket 新记录 | 539 条，ID 连续、有序、无重复 |
| 入库时间至本机 WebSocket 接收 | 平均 4.54ms，P95 5.51ms（不含设备采样前的时间） |
| 本机状态 API 响应 | 平均 14.57ms，P95 28.35ms |
| 实际接收视频 | 1,479 帧，24.63 FPS，JPEG 数据约 66.18kB/s |
| 状态观察 | 56 次状态查询中设备和摄像头均在线 |
| Flask CPU | 单核口径约 4.94%，本机 24 个逻辑处理器折算约 0.21% |

COM3 仅作 12 秒被动读取，没有复位或发送控制命令；109 条成功上传的真实 JSON（ID 72,095～72,203）与 SQLite 对应记录逐字段匹配。数据库 `integrity_check` 返回 `ok`，所有正式记录的三个 gyro 列均为 NULL。

浏览器中 30/60/120 秒窗口分别观察到 270/529/1,067 个真实采样点（在不同时间切换，因此不要求点数严格成倍）。冻结约 11 秒期间保持 1,067 个点，累计样本从 73,018 增至 73,121；恢复后显示实时曲线。视频元素实际尺寸为 320×240，历史列表持续刷新。1920×1080 和 1440×900 保持三栏对齐，360×800 改为单列，页面均无横向溢出；浏览器错误日志为空。

后端 33 项测试、前端 3 项测试和 `node --check web/app.js` 均通过。测试使用隔离环境；性能脚本只执行 GET 和接收 WebSocket，没有向正式数据库生成数据。

本轮验证的是持续真实采集、视频流、入库一致性和新版页面交互。截图时真实摄像头画面较暗；没有重新要求人工移动开发板或镜头前物体，因此不把帧哈希变化当作动作验收。人工姿态/场景变化的确认见上方 2026-09-16 记录。本轮一分钟测量也不代表长期稳定性测试。

本机证据：`.qa/completion-20260918/` 中的 `performance.json`、`serial-readonly.log`、`end-to-end.json`、`browser-results.json`、`backend-tests.log` 和 `completion-report.md`。最终有效截图为 `desktop-1920-online.png`、`desktop-1440-online.png`、`mobile-360-online.png`；内置浏览器产生的 `live-*.png` 有重复条带或裁切问题，不作为最终截图。上一轮离线 Design QA 记录保留在 `.qa/design-audit-20260917/audit-report.md`。
