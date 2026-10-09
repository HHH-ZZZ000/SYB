# 第 9 周：视觉事件主动询问

在原智能助手选择设备，分析明确的历史图片，或明确请求“看看当前画面是否可用”。
未知结果会在当前回复里询问一次；点击“重新拍摄”，或输入/说出“重拍”“是”
“重新拍一张”“确认”，才通过原 `AssistantSession.send()` 创建新图像任务并分析。
点击“忽略”，或输入/说出“不用”“忽略”“算了”“不拍了”，不会调用设备接口。
“算了”在确认卡存在时表示拒绝，在其他任务中继续沿用原取消含义。

## 证据与优先级

| 事件 | 依据 | category | 行为 |
| --- | --- | --- | --- |
| device_unavailable | 真实 offline/无响应回执，或 camera_unavailable | device | 说明设备问题，不询问重拍 |
| capture_failed | 本次 FAILED/TIMEOUT，或晚于分析原图的最近失败回执 | device | 在线且任务终结时可询问一次 |
| image_invalid | 同一图像任务的 invalid 状态，或后端解码/哈希校验明确返回 image_invalid | device | 在线时可询问一次，不执行该图的推理 |
| visual_uncertain | 已核验来源的 BRISQUE unknown / 拒识结果 | model | 在线时可询问一次 |

优先级依表格从上到下。正常 accepted 结果、普通接口错误和模型运行失败不会被猜成
unknown 或图像损坏。模型分数与限制保持原样；不推断“镜头一定遮挡”。
询问前读取原 `/api/status` 设备判断；状态接口失败则记录 deferred，不猜设备在线。
正在等待结果、仍可继续查询的任务不会再询问重拍，以免重复执行设备动作。

## 确认、忽略和冷却

只有当前有效 request 的事件可进入 `awaiting_confirmation`。
确认后先结束旧确认状态，再调用原“新拍图并分析”入口，生成新的 request_id、
image task_id、image_record_id、inference_id；有原推理时沿用第 8 周 retake 人工反馈
记录关联。旧记录不会覆盖。重复确认和已失效卡片按钮不重复提交任务。

忽略后记录 decision/decision_time/cooldown_until，立即回到 idle，停止该询问播报。
同一设备同一事件类型在冷却期间继续记为 suppressed，不再问、不自动播报、不拍摄。
不同设备/类型独立。用户明确发起新任务或点击原重拍按钮仍可执行，冷却只限制主动打扰。
人工纠正为“可用”也结束当前建议，保存原预测，并进入冷却。

默认 120 秒，作为避免短时间反复打扰的交互设置，**不是模型阈值或设备协议时间**。
助手页默认收起的“视觉询问设置”可设 1–3600 秒；修改从下次忽略开始生效。
也可通过 `new AssistantSession(api, storage, { cooldownMs })` 配置，未新增依赖。

## 记录范围与迟到隔离

每个事件包含 event_id、当前交互 request_id、源 inference_id/image_record_id/
image_task_id、device_id、event_type、event_time、category、status，以及用户选择和冷却时间。
没有创建任务/图片/推理时相应字段为 null，绝不生成假来源编号。更高优先级设备问题
来自另一次回执时另存 device_evidence_task_id，不替换原图来源。
确认后追加 decision_request_id/new_task_id，便于追溯新旧关系。

事件与拒绝记录最多保留最近 100 条，冷却键最多 100 个，存在当前浏览器标签页的
sessionStorage（`imu-visual-events-v1`）。无图片字节、语音或敏感配置；存储失败时仍在内存
运行。**这些是本地交互日志，不是服务端永久审计记录**。刷新保留日志和冷却，但不会
恢复旧确认卡。原图片、推理和重拍反馈继续由原后端保存。
用户选择记录 decision_category=interaction，原第 6 周请求审计也增加 category=interaction。

依旧使用原 scopedApi/AbortController/isCurrent：推理后及设备状态读取后均检查当前
request_id。取消或新请求替代时结束确认；旧请求的迟到推理/状态不会弹卡、播报或创建任务。
没有改固件、BRISQUE、request_id 生成、后端表结构、ASR 或 TTS 实现。

## 定向软件测试

运行：

```powershell
node --test tests/test_visual_events.mjs tests/test_vision.mjs tests/test_assistant_requests.mjs tests/test_assistant_images.mjs tests/test_assistant_voice.mjs
```

软件测试使用隔离的合成传输和浏览器语音事件，不能当成真实设备/真人声音证据。
覆盖接受结果不询问、unknown 单次询问、各种确认/拒绝、冷却及过期、来源优先级、
损坏图片、接口失败、取消、迟到隔离、重复确认、人工纠正、语音/文字/按钮同入口。

## 本次实际验证（2026-09-30）

- 上述 76 项定向测试全部通过。
- 真实浏览器分析历史图片 6：BRISQUE 分数 53.2787，unknown，只显示确认卡。
  确认前数据库设备任务总数仍为 28，无自动拍摄。
- 点击确认后任务 `9b9c55dd-8d64-47a4-bf39-1331464f28cd` SUCCESS，
  交互 request `c16275e2-6399-4fb3-9b8b-f9e452822a8f`。
  ESP32 新图片记录 8，拍摄时间 **2026-09-30 09:41:26（北京时间）**；4775 字节，
  Pillow 完整解码为 320×240 JPEG。
  新推理 `de65844d-bd20-473a-88e0-15e0da4e187e`，BRISQUE 55.4669 / unknown。
  旧推理 `2209a257-3a83-42ad-b983-a539a47e966a` 保留，原 retake 反馈保存新任务关联。
- 点击忽略后再次分析图片 8：新推理记录存在，页面显示冷却且没有确认按钮；
  任务数维持 29，没有新图片/重拍。
- 真实历史图片 2 的 accepted 结果未触发确认卡。
- 冷却期结束后重新分析历史图片 6，恢复一次确认卡；点击“取消当前任务”结束询问，
  没有增加拍摄任务。浏览器无控制台警告/错误。
- 原生滚轮测试：卡片内向上滚动只改变对话 scrollTop；到顶后继续向上，页面 scrollY
  从约 242 变为 0；到底后继续向下，页面 scrollY 从约 92 变为 242。新回复到达时，
  用户停留在历史顶部的位置仍保持 0，没有被拉回底部。未修改 wheel/overscroll 逻辑。
- 当前记录中真实设备继续上传 IMU；没有修改任何固件或传感器代码。
- 离线、摄像头故障、损坏图片、取消后迟到结果是软件测试验证；没有拔线或破坏真实图片。
  真人麦克风说出确认/拒绝、实际听取 TTS 和触控板操作仍需现场验收。
