# 第 8 周：视觉推理与反馈

本周接入的是**公开预训练画质基线**，不是本项目专用模型或教师模型。没有训练、校准，
也没有增加人脸、身份、地点、人员安全或场景分类能力。ESP32 固件、ASR/TTS 未修改。

## 使用

运行根目录 `run.bat`，在原“智能助手”选择设备后输入：

- `分析刚才拍的图片` / `这张图片能用吗？`：仅使用当前对话明确关联的已验证图片。
- `分析图片记录 2`：明确选择历史图片；沿用其原拍摄时间，不重新拍摄。
- `看看当前画面是否可用`：复用第 7 周 image_capture，等待并校验本次图片后推理。

目标不明确会询问；不自动选择数据库中的“最新图片”。图片下可直接“分析这张图片”。
分析卡片提供“重新拍摄并分析”和“人工纠正”。重拍产生新的设备任务、图片和推理编号；
失败不读旧图顶替。展开“人工纠正”选择人工判断并保存，原模型结果保留。
没有摄像头连接时仍可分析尚在保留期内的已有照片。

## 模型、分数和限制

采用 OpenCV 官方 BRISQUE LIVE-R2 预训练支持向量回归模型。来源：
[官方模型文件](https://github.com/opencv/opencv_contrib/blob/4.10.0/modules/quality/samples/brisque_model_live.yml)、
[说明与分数定义](https://docs.opencv.org/4.10.0/d8/d99/classcv_1_1quality_1_1QualityBRISQUE.html)。
约 555 KB 权重及特征范围文件包含在 `server/models/brisque/`，附官方 LICENSE。
每次运行校验两文件 SHA-256，无运行时下载，无向外部服务上传图片。

模型版本：`opencv_contrib-4.10.0/live-r2/4c44c7eec9e5+a18427f4f7ad`。
新增固定依赖只有 `opencv-contrib-python-headless==4.10.0.84` 和 `numpy==2.2.6`；
已在项目 Python 3.11 虚拟环境安装、运行。CPU 推理，不引入 PyTorch/TensorFlow。

**原始输出是 BRISQUE 失真回归分数，范围 0–100，越低越好。**
它没有类别置信度；不能将 100-score 冒充置信度、准确率或“可用概率”。
不提供遮挡标签，模型也不能确认画面是否符合具体使用目的。

页面的标签是明确标记的**应用画质分段**，不是伪造的模型原生类别：

| 应用标签 | 默认规则 | 含义 |
| --- | --- | --- |
| quality_good | score ≤ 30 | 失真较少的参考，仍需人工确认用途 |
| quality_poor | score ≥ 60 | 失真较多的参考，建议重拍或确认 |
| unknown | 30 < score < 60 | 规则中间区间，拒绝给出明确画质建议 |
| unknown | 特征或分数无效 | 无法可靠计算，不强行输出确定判断 |

30/60 是显式可调整的**试运行应用参数**，不是论文推荐阈值，也不是在 ESP32 数据集验证过的
置信阈值。默认留出宽中间区间来拒识；每条记录保存当时配置。可在启动后端前设置：

```powershell
$env:IMU_VISION_GOOD_MAX = '30'
$env:IMU_VISION_POOR_MIN = '60'
.\run.bat
```

必须满足 `0 ≤ good_max < poor_min ≤ 100`；配置错误明确返回推理失败。
纯黑等退化输入的特征可能非有限数，直接记录 unknown/null score，不用裁剪后的值制造判断。
所以本实现的“未知”是质量区间/数值有效性拒识，**不是经过校准的语义未知或遮挡识别**。

## 关联与保存

- `GET /api/vision/images/<image_record_id>`：只查明确编号对应的任务，不提供 latest 图片路由。
- `POST /api/vision/infer`：只接受 request_id、image_record_id、image_task_id、device、capture_time。
  路径从数据库获取，客户端不能传入任意路径/URL。
- `GET /api/vision/inferences/<inference_id>`：读取原预测及纠正/重拍记录。
- `POST /api/vision/feedback`：追加 correction 或 retake，不能更新预测。

`vision_inferences` 保存 inference_id、助手 request_id、图片和任务编号、设备、拍摄时间、
原路径、图片 SHA-256、model_name、model_version、inference_time、label、score、status、reason、
策略快照和模型原始数值/运行库版本。同一 request_id+图片的重复提交返回同一条记录。
文件过期后元数据仍可追溯；照片继续复用第 7 周最近 20 张/10 分钟阅读保护机制，不另存图片副本。

`vision_feedback` 保存反馈编号、inference_id、原标签/分数、人工标签、反馈时间；
重拍反馈额外记录新 request_id、新图像 task_id，可查询其新 image_record_id/inference_id。
人工标签 usable/unusable/occluded/unknown 都标为人工判断，**不说成模型预测**。
如果重拍任务已创建而关联接口暂时失败，保留任务编号及续查入口；续查会用原创建请求编号
幂等补存关联，然后读取同一个任务，不再次拍摄。取消仍隔离迟到的保存结果。

数据库仅从 v6 增加两张表至 v7；不重建采样表，不改 IMU 或图像任务数据。
本地迁移前备份位于 `.qa/week8-before/sensor.db`，不要用旧备份覆盖新增记录。

语音、文字、图片操作继续通过原 `AssistantSession.send()`，推理请求使用原 scopedApi/AbortController
所有权隔离。取消后后台计算可能保存原 inference，但不会覆写新请求、展示迟到结果或触发播报。
前后端都核对具体图片、任务、设备、拍摄时间及 SHA-256；任务关联不依赖“最近一次上传”。
每个推理输入在读出期间受已有保留锁保护，模型运行使用已验证的同一份字节，不持有数据库写锁。

## 实际验证（2026-09-30）

### 真实模型证据

- 三张第 7 周真实 ESP32 历史 JPEG 运行 BRISQUE：60.87、62.75、61.36。
- 浏览器通过原助手指定 `ESP32_S3_EYE 图片记录 2`，产生推理
  `d6f93e8b-bba3-4ebf-9706-f22d69fe4828`，绑定图像任务
  `2d089a47-0ef3-43ef-9bb4-31161e0c4071`，原拍摄时间 **2026-09-29 20:08:09**，
  score=62.753299713134766。图片及模型信息实际显示，非新拍摄。
- 浏览器保存“不确定”人工反馈 `c2ba5d91-736d-4490-8cd7-c1a1bc5fe5ca`；
  再查接口，原 label=quality_poor 和原 score 保持不变。
- 最终代码启动后，再用浏览器自动化点击展开“人工纠正”、选择“不确定”并保存；页面显示
  2026-09-30 01:50:24 反馈，服务端返回 HTTP 201。截图 `.qa/week8-final-vision.png`。
- `tests/verify_vision_baseline.py` 在临时数据库，使用真实模型对公共水果照片及明确派生输入推理：

| 输入 | 实测分数 | 反馈 |
| --- | --- | --- |
| 公共照片（JPEG 重编码测试输入） | 12.27 | 失真较少参考 |
| 人工模糊派生图 | 69.93 | 失真较多参考 |
| 人工涂黑 85% 派生图 | 38.52 | 中间区间 unknown |
| 生成的纯黑图 | null | undefined_features，unknown |
| 人工涂黑一半派生图 | 25.73 | 仍给出失真较少；不能据此判断用途可用 |

最后一个是**有利质量分数但不能保证用途可用的反例**，已独立追加人工 unusable 反馈且保留原值。
不能把它叫作“高置信分类误判”，因为该模型没有置信输出。课程要求的严格“高置信误判”比较仍需
有真实类别置信分数的适用模型；本周没有伪造这种输出。

公共输入来自 [OpenCV 4.10.0 fruits.jpg](https://github.com/opencv/opencv/blob/4.10.0/samples/data/fruits.jpg)。
派生图片不是实体镜头遮挡或本次硬件采集。临时库设备协议为模拟，模型计算是真实。
报告在 `.qa/week8-real-model-api-report.json`；真实历史照片报告与反馈在
`.qa/week8-live-inferences.json`、`.qa/week8-live-feedback.json`。

### 软件定向测试

后端 `test_vision.VisionTests` / `RealBaselineTests` 分批定向执行，共 12 个用例已通过；
覆盖质量区间、退化拒识、模型失效、图片错配/损坏、明确选图、版本、幂等、保留保护、纠正、重拍及迁移。
初次测试发现测试代码未关闭 SQLite 连接导致 Windows 临时目录清理失败，已修复并定向复测。
相关第 7 周成功关联/离线及原助手解析回归 20 项通过。

前端 `test_vision.mjs`、`test_assistant_images.mjs`、`test_assistant_requests.mjs` 共 24 个用例
分批通过，覆盖真实入口复用、无图澄清、旧图错配、离线不创建任务、取消/迟到隔离和纠正不触发 TTS。
其中注入的数值和传输响应**仅为软件模拟，不计入真实模型准确性证据**。
收尾审查发现“任务已创建、重拍关联接口失败”会丢失续查入口，已修复；新增两项用例验证
503 后仍能补存关联并续查原任务，以及取消后迟到关联不恢复请求，相关重拍正常路径也复测通过。

针对实现有改动的部分才补跑测试，没有运行全项目套件。复现命令：

```powershell
cd server
../.venv/Scripts/python.exe -m unittest test_vision.VisionTests test_vision.RealBaselineTests -q
cd ..
node --test tests/test_vision.mjs tests/test_assistant_images.mjs tests/test_assistant_requests.mjs
.venv/Scripts/python.exe tests/verify_vision_baseline.py .qa/week8-public-fruits.jpg .qa/week8-real-model-api-report.json
```

### 尚未现场验证

电脑 WLAN 为 10.252.246.183，设备仍访问 192.168.3.15:5000；COM3 实际显示 IMU 运行以及
ESP_ERR_HTTP_CONNECT/连接超时。仅执行已有 resume 命令，未改固件或 WiFi。
用户选择不切换网络，故**本周真实新拍摄→推理→重拍尚未硬件验收**。
真实设备的取消中途/迟到推理、物理遮挡、现场画质阈值、真人麦克风和 TTS 听感也未验证。
浏览器自动化已验证文字分析指定真实历史图片、结果展示、键盘提交及点击展开/提交人工反馈；真人鼠标和实体触控板需现场验收。
原对话 max-height、overflow-y:auto、overscroll-behavior-y:auto 保持不变，无新增 wheel 拦截。

## 本周文件清单

- 后端新增：`server/vision_model.py`、`server/vision.py`、`server/models/brisque/`（模型、范围、LICENSE、来源说明）。
- 后端修改：`server/app.py`、`server/database.py`、`server/assistant.py`、`server/requirements.txt`。
- 前端新增：`web/services/visionTools.js`。
- 前端修改：`web/services/assistantSession.js`、`web/services/assistantTools.js`（等待已创建回调、保留关联失败任务续查）、
  `web/services/api.js`（仅推理 15 秒上限）、`web/pages/Assistant.js`、`web/assistant.css`（仅视觉卡片操作区）。
- 测试新增：`server/test_vision.py`、`tests/test_vision.mjs`、`tests/verify_vision_baseline.py`。
- 启动/说明：`run.bat`、本文 `server/VISION.md`。

没有修改 ESP32、图像上传/驱动、三轴采集、语音实现、其他页面或第 6 周请求所有权核心机制。
