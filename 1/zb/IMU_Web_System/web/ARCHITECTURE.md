# 多模块数据监控平台

本次改造保留原生前端、Flask、SQLite 和硬件协议。新增页面共享一份实时状态，避免每次切换模块重新创建连接。原有 `style.css` 完整复用，新布局集中于 `platform.css`。

## 修改与新增文件

| 文件 | 职责与变化 |
| --- | --- |
| `web/index.html` | 应用外壳、本地图表资源、模块入口与隔离测试标识插槽 |
| `web/app.js` | 组装共享数据服务、导航与路由；不再包含单页面业务代码 |
| `web/router.js` | Hash 路由、动态 import、标题和导航状态；离开页面执行清理 |
| `web/package.json` | 声明 ES Module，供原生 Node 测试识别；无 npm 依赖 |
| `web/platform.css` | 固定导航、六模块布局、响应式样式，复用原色彩与卡片规范 |
| `web/models/Device.js` | Device 模型转换、有效采样检查、去重与实时窗口过滤 |
| `web/services/api.js` | HTTP 数据访问、超时、取消请求；接口替换边界 |
| `web/services/telemetry.js` | 共享状态、单路 WebSocket、增量轮询、重连与设备切换 |
| `web/services/captureTask.js` | 从旧页面提取的任务提交、状态恢复、物理按键任务发现和中文错误提示 |
| `web/services/preferences.js` | 本机偏好校验、保存与默认值 |
| `web/lib/format.js` | 北京时间、数值和 DOM 辅助函数 |
| `web/components/Navbar.js` | 固定顶部品牌、服务器连接状态、最近接收时间、用户入口 |
| `web/components/Sidebar.js` | 六个导航项、选中状态、可访问名称与设备数量 |
| `web/components/Icons.js` | 共用线性 SVG 图标 |
| `web/components/DeviceCard.js` | 设备状态卡与三轴/合加速度测量卡 |
| `web/components/DataChart.js` | ECharts 实时折线图、暂停/继续、轴开关、自适应与实例释放 |
| `web/components/CameraPanel.js` | 同源 MJPEG 预览、独立离线状态、失败重试、隐藏/卸载释放视频 |
| `web/components/DataTable.js` | 统一采样表格、空状态、数字与时间格式 |
| `web/pages/shared.js` | 页面外壳、设备选择、警告、刷新按钮和统计卡 |
| `web/pages/Dashboard.js` | 运行总览、在线/离线统计、累计样本、最新采样与模块入口 |
| `web/pages/DeviceMonitor.js` | 原设备监控功能：设备、采集任务、测量、趋势、摄像头与最近记录 |
| `web/pages/RealTimeData.js` | 持续更新的三轴曲线与传感器列表、手动刷新和时间排序 |
| `web/pages/HistoryData.js` | 北京时间查询、分页、排序、完整筛选结果导出 |
| `web/pages/CameraManage.js` | 设备摄像头列表、选中设备预览 |
| `web/pages/Settings.js` | 设备信息、网页刷新偏好与本机用户显示设置 |
| `web/vendor/echarts.min.js` | 固定 ECharts 5.6.0，浏览器只读取本地副本 |
| `web/vendor/ECHARTS-LICENSE.txt`、`ECHARTS-NOTICE.txt` | 图表库许可证及归属声明 |
| `server/app.py` | 注册只读查询模块、新增真实设备列表接口；原上传与任务接口保持兼容 |
| `server/records.py` | 只读历史查询、参数校验、完整 CSV 流式导出 |
| `test_client.py` | 适配新页面的模拟数据标识，保持其独立数据库/端口约束 |
| `server/test_records.py` | 历史查询、导出、设备隔离与模块资源服务测试 |
| `tests/test_dashboard.cjs` | 将原采集任务回归用例移至提取后的控制器；增加卸载竞态检查 |
| `tests/test_platform.mjs` | 模型、曲线数据、连接恢复、去重、设备切换、偏好校验测试 |
| `README.md`、`web/ARCHITECTURE.md` | 运行、架构、交付范围与扩展说明 |

仓库原有未提交的固件、数据库、任务服务和样式变更保留，不属于本次新增改动。正式 `server/sensor.db` 未注入任何测试样本。

## 路由与生命周期

| URL 片段 | 页面 |
| --- | --- |
| `#/dashboard` | 首页总览，默认入口 |
| `#/monitor` | 设备监控 |
| `#/realtime` | 实时数据 |
| `#/history` | 历史数据 |
| `#/cameras` | 摄像头管理 |
| `#/settings` | 系统设置 |

页面只导出 `mount(container, {store, api})`，返回清理函数。路由切换注销订阅、释放图表、移除视频地址和页面定时器；共享数据服务继续接收真实记录。异步页面加载用版本编号忽略过期结果，浏览器前进/后退使用原生 hashchange。

实时服务维护最多 2,000 条记录，按 ID 去重、接收时间和 ID 排序。默认展示 20 秒，可在设置中选择 30、60、120 秒。冻结复制当前样本与时间窗口，只影响当前图表；测量和表格继续更新。采样间隔超过 1.5 秒时折线断开，避免把断流画成连续测量。

WebSocket 不可用时执行增量 HTTP 轮询，构造连接失败仍继续重试；页面隐藏会暂停请求和视频，重新可见后同步。设备切换使用请求版本隔离，旧设备的迟到结果不会进入新设备曲线。

## 统一设备模型

```js
// 参见 models/Device.js 中的 JSDoc 类型和 toDevice()
Device = {
  id,                           // 后端 device 标识
  name,                         // 显示名称
  status,                       // online / offline / unknown
  lastUpdate,                   // 服务器接收时间，毫秒或 null
  acceleration: { x, y, z },     // 单位 g，缺失时为 null
  cameraStatus,                 // online / offline / unknown
  sampleCount                   // 服务器累计数量；未知时为 null
}
```

模型另携带 `sensor`、设备采样时间 `timestamp` 和相机元信息 `camera`。服务器不可达显示未知状态，而不是将所有设备误算成离线。设备 10 秒无新入库记录即离线，相机 5 秒无最近帧即过期。

统一 API 适配在 `services/api.js`。已有真实 Flask 后端，因此正式页面不自动注入 mock。需要脱离硬件测试时，使用 `test_client.py` 启动隔离模拟服务，例如：

```powershell
.\.venv\Scripts\python.exe test_client.py --port 5001 --samples 20 --interval 0.1 --verify
```

未来更换后端时，在该适配层转换接口返回值，并保持 `toDevice()` 与采样模型契约；避免在每个页面单独转换字段。

## 新增只读接口

- `GET /api/devices`：返回 `devices` 数组，每项遵循现有 `/api/status` 的结构；设备标识来自数据库，另保留默认板卡入口。
- `GET /api/records?device=...&start=...&end=...&order=desc&page=1&page_size=20`：返回 `samples,total,page,page_size`。每页 1–100 条；时间按北京时间解释，过滤**服务器接收时间**，边界包含在内。相同时间按 ID 排序。
- `GET /api/records/export?device=...&start=...&end=...&order=desc`：导出全部匹配记录，不受分页大小和 2,000 条实时缓存限制。CSV 含 UTF-8 BOM，分批读取以控制内存，并处理可能被电子表格当作公式的设备名。导出读取下载时的数据库快照。

SQL 值使用参数绑定；排序方向使用白名单。没有修改数据库结构、原增量历史接口或采集写入协议。

## 已实现与扩展边界

- 已实现：六模块路由、真实设备列表/选择、共享三轴数据、离线提示、采集任务、图表、历史查询/导出、现有相机代理、本机偏好。
- 设备配置：当前可查看设备标识和硬件参数、保存工作台备注。修改真实上传地址或采样周期仍需按固件配置流程执行，网页不会声称已下发硬件命令。
- 用户设置：仅本机显示名与偏好，尚未增加登录、用户数据库或权限体系。
- 多摄像头：列表支持不同设备状态，但后端当前仅代理默认板卡的视频；其他设备明确显示视频源待配置。真正多路视频需要新增按设备管理的视频源接口。
- 设备注册：当前从采样库发现设备；若需预先登记从未上传的设备，下一步增加设备注册表及对应维护接口。
- 大数据量：可在实测查询瓶颈出现后增加 `(device, received_at, id)` 索引与游标分页；无需为当前改造迁移数据。

## 验证

从项目目录运行：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s server -v
node --test tests/test_dashboard.cjs tests/test_platform.mjs
```

本轮 79 项后端、23 项前端测试通过。保留原任务中文状态、失败处理、提交只发一次、恢复已知任务、实体按键任务发现测试；另外覆盖新历史接口、CSV、缺少 WebSocket、重连、页面隐藏、乱序数据、设备切换竞态等。

浏览器操作验证了六个模块的加载、图表冻结/继续与轴切换、冻结时测量值和表格继续更新、实时排序、历史分页/升序/空结果/导出下载、摄像头离线占位、用户偏好保存后恢复。响应式检查包括大屏 1920、笔记本 1440、平板 1024/768，以及补充窄屏 390 像素。

本地证据在忽略提交的 `.qa/module-upgrade/`：测试日志、响应式尺寸结果、改造前前端备份、独立预览数据库。在线曲线使用原有隔离测试工具生成的模拟样本；正式历史库通过只读连接备份用于离线预览。本轮没有验证实物实时视频、远程固件调频或重新烧录硬件。

ECharts 用法参考 [官方入门文档](https://echarts.apache.org/handbook/en/get-started/) 和 [容器尺寸与释放说明](https://echarts.apache.org/handbook/en/concepts/chart-size/)。库文件来源为 npm `echarts@5.6.0` 的 `dist/echarts.min.js`，许可证随项目保留。
