# 扩展案例 3：猫狗分类模型 SD 卡静态图片推理

> 类型：`FW` ｜ 验证状态：参考值，待实机校准 ｜ 前置：[`extensions/02_quantize_catdog_model`](../02_quantize_catdog_model/)

## 摘要

微课最小案例 3 把"会算 sin"的小模型嵌进固件，证明 ESP32 能跑量化模型。这个扩展案例更进一步：ESP32-S3-EYE 从 MicroSD 卡读一张 JPG 和一个猫狗模型（`.espdl`），解码、预处理、推理，最后在串口打印"猫还是狗、置信度多少、推理花了多少微秒"。和微课的两个区别：一是**模型和图片都放 SD 卡**，换素材不用重新编译烧录；二是**输入从一个数字变成一整张彩色图片**，多出"读文件 → JPEG 解码 → 预处理"这几步。本案例只用**单张静态图片**，不涉及摄像头实时预览；实时猫狗分类是后续阶段性作业的内容。

## Quick Start

**预备知识（零基础必读）**

- **ESP-IDF / `idf.py`**：编译 `idf.py build`，烧录 `idf.py -p <PORT> flash`，看日志 `idf.py -p <PORT> monitor`；用之前先加载 IDF 环境（`. <IDF安装目录>/export.sh`）。monitor 默认波特率 115200，退出按 **`Ctrl + ]`**。
- **BSP（esp32_s3_eye）与挂载**：BSP 是板级支持包，把"这块板的 SD 卡、摄像头怎么接"封装成 `bsp_sdcard_mount()` 这类函数（组件管理器自动拉取）；挂载就是让固件把 SD 卡当成可访问的目录树，挂载点 `/sdcard`，**卡必须是 FAT32** 才能读到。
- **8.3 短文件名与 LFN**：FAT 最古老模式只支持"8 字符主名 + 3 字符扩展名"（如 `sample.jpg`），更长的名字（如 `catdog_mobilenet_v2.espdl`）需要开启**长文件名支持（LFN）**。⚠️ 本工程默认是 `CONFIG_FATFS_LFN_NONE=y`（未开启），**必须按 Quick Start B.0 步开启**，否则模型文件在板上打不开。
- **PSRAM**：板载外部大内存。解码后的彩色图片动辄几百 KB，内部 RAM 放不下，所以 JPEG 字节和像素都从 PSRAM 申请（`MALLOC_CAP_SPIRAM`）。
- **JPEG / RGB888**：JPEG 是压缩格式，模型不能直接吃，要先解码成像素；RGB888 表示每像素红绿蓝各 8 位。文件名要全小写、无空格、无中文，路径严格按代码常量写。

**模型和图片从哪来？** 模型是前置案例 [`extensions/02_quantize_catdog_model`](../02_quantize_catdog_model/) 的产物 `outputs/catdog_mobilenet_v2.espdl`；图片用一张公开的猫或狗照片（**不要提交个人照片或含敏感信息的图片**）。


**A. 准备 SD 卡（在电脑上操作）**

1. MicroSD 卡插入读卡器接到电脑，确认是 **FAT32**（不是就备份后格式化，卡建议 ≤ 32 GB），然后在卡的**根目录**下建好目录和文件，文件名、大小写、路径都要和代码常量一致：

```text
<SD卡根目录>/
├── models/
│   └── s3/
│       └── catdog_mobilenet_v2.espdl   ← 复制自 extensions/02_quantize_catdog_model/outputs/
└── images/
    └── sample.jpg                       ← 一张公开的猫或狗照片
```

2. 在本目录下执行复制（`<SD卡挂载点>` 换成 SD 卡实际路径，如 macOS 的 `/Volumes/XXXX`）。代码写死的路径是 `/sdcard/models/s3/catdog_mobilenet_v2.espdl` 和 `/sdcard/images/sample.jpg`（`kModelPath`/`kImagePath`），板端的 `/sdcard` 就是卡根目录：

```bash
cp ../02_quantize_catdog_model/outputs/catdog_mobilenet_v2.espdl <SD卡挂载点>/models/s3/
cp <你的一张猫或狗照片>.jpg <SD卡挂载点>/images/sample.jpg
```

3. 安全弹出 SD 卡，插回 ESP32-S3-EYE 的卡槽。

**B. 构建、烧录、观察（终端已加载 IDF 环境）**

**B.0 开启 SD 卡长文件名支持（重要，只需做一次）**

模型文件名 `catdog_mobilenet_v2.espdl` 远超 8.3 短名限制，而本工程默认 `CONFIG_FATFS_LFN_NONE=y`（LFN 关闭），不开启板上就打不开模型：

```bash
cd extensions/03_catdog_static_infer
echo "CONFIG_FATFS_LFN_HEAP=y" >> sdkconfig.defaults   # 追加"长文件名缓冲放在堆上"
rm -f sdkconfig                    # 删掉旧配置，让 defaults 重新生效
idf.py set-target esp32s3          # 若尚未设置目标，先执行
```

`CONFIG_FATFS_LFN_HEAP=y` 对应图形化配置菜单里 `Component config` → `FAT Filesystem support` → `Long filename support` 的 `Using heap` 选项。**构建之后**用 `grep FATFS_LFN sdkconfig` 确认结果是 `CONFIG_FATFS_LFN_HEAP=y` 而不是 `CONFIG_FATFS_LFN_NONE=y`，再烧录。

**B.1 构建与烧录**

```bash
idf.py --version          # 应显示 v5.4.x
idf.py build              # 首次会联网拉 esp-dl、esp32_s3_eye 等组件，约 3~10 分钟
# 有开发板时（<PORT> 换成实际串口：macOS 为 /dev/ 下 cu 开头设备的完整路径，Windows 如 COM3）：
idf.py -p <PORT> flash monitor
```

程序上电后自动跑一遍就结束（不循环），看完按 **`Ctrl + ]`** 退出 monitor。没有开发板时只能验证到 `idf.py build`；**模型加载、JPEG 解码、分类结果必须在插了 SD 卡的真实板子上才能验证**。

## 预期现象

与代码 `ESP_LOG` 格式一致的成功日志示例（毫秒数会变，尺寸、分数、耗时取决于你的图片和板子；**格式示例，具体数值以实机为准**）：

```text
I (310) catdog_static_infer: SD card mounted at /sdcard
W (520) dl::Model: minimize() will delete unused inference variables, breaking model testing/debugging.
I (980) catdog_static_infer: decoded /sdcard/images/sample.jpg: 224 x 224 in 45321 us
I (1102) catdog_static_infer: top1=cat score=0.987654 infer=12345 us
```

- 挂载时你可能总会看到一条 `W (xxx) ESP32-S3-EYE: Warning: Long filenames on SD card are disabled in menuconfig!`——这是 BSP 检查旧版配置符号导致的**固定输出，开启 LFN 后也会打印，可以忽略**；判断 LFN 是否真开启，以电脑上 `grep FATFS_LFN sdkconfig` 的结果为准。那条 `minimize()` 的 `W` 同样是正常现象。
- `decoded ... 224 x 224 in 45321 us`：解码后的像素尺寸（是你原图的尺寸，resize 在预处理里做）和解码耗时；`top1=cat score=0.987654 infer=12345 us`：分类结果、softmax 置信度、纯推理耗时。**解码耗时和推理耗时是两个独立的数**，这正是本案例要观察的重点之一。失败时程序打印明确错误并停止，**不会伪造 Top-1**：`SD card mount failed`（挂载失败）、`cat/dog model load failed`（模型缺失或无效）、`cannot open image`（路径/文件名不对）、`image read failed`（读取或内存问题）、`JPEG decode failed`（不是合法 JPEG）、`classifier returned no result`（模型与后处理不匹配）。

**常见问题排查**

| 现象 | 原因 | 解决 |
|---|---|---|
| `SD card mount failed` | 卡没插到位、不是 FAT32、卡损坏 | 重新插拔；电脑上格式化为 FAT32（≤32 GB）；换卡试 |
| `cat/dog model load failed` + `model has no input/output tensors` | 模型路径/文件名不对，或**未开启 FAT 长文件名（`CONFIG_FATFS_LFN_NONE=y`）导致长文件名根本打不开** | 确认卡上有 `models/s3/catdog_mobilenet_v2.espdl`；电脑上 `grep FATFS_LFN sdkconfig`，若不是 `CONFIG_FATFS_LFN_HEAP=y`，按 B.0 开启后重新 build + flash |
| `cannot open image: /sdcard/images/sample.jpg` | 图片没拷进去、名字不对（如 `.jpeg`、大小写不符）、`images/` 没建 | 严格按 `images/sample.jpg` 放置，全小写无空格 |
| `image read failed` / `JPEG decode failed` | 空文件或 PSRAM 不够；文件不是合法 baseline JPEG（改名 PNG、渐进式、CMYK） | 换有效的普通 RGB JPEG；确认 `CONFIG_SPIRAM=y` 生效；别用超大分辨率图 |
| 分类总错、score 接近 0.5 | `kMean`/`kStd` 或 `kCatDogLabels` 与训练不一致 | 对照最小案例 1 训练脚本核对归一化参数和类别顺序 |
| `idf.py -p <PORT> flash` 打不开串口 / Permission denied | 端口写错、被占用，或 Linux 缺权限 | 核对端口、关掉占用程序；Linux 执行 `sudo usermod -aG dialout $USER` 后重登录 |

## 学习目标

- 会按固定目录结构准备 SD 卡（模型 + 一张测试图），理解为什么文件名不能乱改；
- 会构建、烧录目标芯片为 `esp32s3`、依赖 SD 卡与摄像头 BSP 的 ESP-IDF 工程；
- 能说清每一步：读文件进 PSRAM、JPEG 解码为 RGB888、归一化预处理、推理、softmax 取 Top-1；
- 能根据串口错误日志判断问题出在 SD 挂载、文件缺失、JPEG 解码、模型加载还是内存分配，并理解解码耗时与推理耗时为什么要分开测。

## 原理讲解

整条流水线每一环都对应 [`main/app_main.cpp`](main/app_main.cpp) 里的一段代码。

**1. 挂载 SD 卡**

`bsp_sdcard_mount()` 用 SDMMC 主机（Slot 0、1-bit）把卡挂载到 `/sdcard`。挂载失败（卡没插好、不是 FAT32、卡损坏）会返回错误码，程序打印 `SD card mount failed` 后**直接退出**。BSP 配置里 `format_if_mount_failed=false`，挂载失败时**不会自动格式化**你的卡。

**2. 从 SD 卡加载猫狗模型**

模型由 [`CatDogClassifier`](main/catdog_classifier.hpp) 封装，构造时用 `new dl::Model(model_path, fbs::MODEL_LOCATION_IN_SDCARD)`，构造函数内部自动完成 `load()` + `build()`。**和微课不同**——微课为了检测失败用显式两阶段 `load()`，这里失败不会抛错，只能靠随后 `get_inputs().empty()` 判断；没有输入/输出张量就打印 `model has no input/output tensors`，`m_ready` 保持 `false`。接着调用 `m_model->minimize()`：删除推理用不到的中间变量，**省下宝贵的 PSRAM/内部 RAM**；代价是之后不能再对模型做 `test()`/调试，这也是那条 `ESP_LOGW` 警告"breaking model testing/debugging"的含义——板端内存紧张时，省内存优先。

最后建好预处理器和后处理器，`m_ready = true`；主程序用 `classifier.is_ready()` 判断，不可用就打印 `cat/dog model load failed` 并卸载 SD 卡退出。

**3. 读图片到 PSRAM 并解码**

`read_file()` 把文件整个读进内存：`fopen` → `fseek/ftell` 量长度 → `heap_caps_malloc(length, MALLOC_CAP_SPIRAM)` 在 PSRAM 申请缓冲 → `fread` 读满 → 校验字节数。文件不存在、长度为 0、内存不够、读不满，任一情况都返回 `false`，**绝不拿半个文件去解码**。接着 `dl::image::sw_decode_jpeg(jpeg, DL_IMAGE_PIX_TYPE_RGB888)` 把 JPEG 字节软件解码成像素图（`img_t`，含 `data`/`width`/`height`），前后用 `esp_timer_get_time()` 夹住测出**解码耗时**；解码完立即 `heap_caps_free(jpeg_data)` 释放 JPEG 缓冲，把内存让给推理。解码失败（`image.data` 为空）打印 `JPEG decode failed` 退出。

**4. 预处理：resize + 归一化**

`ImagePreprocessor` 把任意尺寸的解码图 resize 到模型输入尺寸，再用**与训练完全一致的均值/标准差**归一化。参数是 MobileNetV2 常用的 ImageNet 统计量，注意 ESP-DL 要求 **0~255 量纲**，所以代码里把 0.485 这类值都乘了 255。这一步是"训练/部署一致性"的关键：参数对不上，模型会算出看似正常实则错乱的结果。

**5. 推理 + 后处理，输出 Top-1**

`classifier.run(image)` 内部依次做"预处理 → 模型 `run()` → 后处理"。后处理器 `CatDogPostprocessor` 继承 `dl::cls::ClsPostprocessor`，构造参数 `(model, topk=2, score_thr=0.0, need_softmax=true, "")`：对 2 个类别做 **softmax** 转成概率、取 **Top-2**、不设分数阈值，类别名映射到 [`labels.hpp`](main/labels.hpp) 的 `{"cat", "dog"}`。主程序用时间戳夹住 `run()` 测出**推理耗时**，取 `results.front()`（Top-1）打印标签和分数；收尾时释放像素并 `bsp_sdcard_unmount()` 卸载 SD 卡。

![视觉模型训练、量化与部署链路图（AI 生成示意）](../../docs/assets/ai_generated/vision_train_quant_deploy.png)

> 图：本案例使用链路末端的 `.espdl` 模型，但模型和图片都从 SD 卡加载，便于替换素材。图示不表示本案例会重新训练模型。

## 整体流程图

```text
前置：extensions/02 产物 catdog_mobilenet_v2.espdl + 一张公开猫/狗照片（改名 sample.jpg）
                 ↓ 拷贝到 SD 卡固定路径
/sdcard/models/s3/catdog_mobilenet_v2.espdl 与 /sdcard/images/sample.jpg
                 ↓ bsp_sdcard_mount() 挂载 /sdcard
CatDogClassifier 加载模型 → minimize() → 建预/后处理器
                 ↓ read_file() 把 sample.jpg 读进 PSRAM
sw_decode_jpeg() 解码为 RGB888（测解码耗时）→ 释放 JPEG 缓冲
                 ↓ classifier.run()：resize+归一化 → 推理 → softmax → Top-1（测推理耗时）
打印 top1=cat/dog  score=0.xxxxxx  infer=xxxxx us
                 ↓ 释放像素 → 卸载 SD 卡 → 结束
```

## 关键代码解析

**1. 固定的 SD 卡接口契约（main/app_main.cpp）**

```cpp
static const char *TAG = "catdog_static_infer";
static constexpr char kModelPath[] = "/sdcard/models/s3/catdog_mobilenet_v2.espdl";
static constexpr char kImagePath[] = "/sdcard/images/sample.jpg";
```

这两个常量就是你和 SD 卡之间的约定：要么按这个路径放文件（本课程选这条，换素材不用重编固件），要么改这里重新编译。

**2. CatDogClassifier：模型 + 预/后处理封装（main/catdog_classifier.hpp）**

```cpp
static const std::array<float, 3> kMean = {0.485f*255, 0.456f*255, 0.406f*255};
static const std::array<float, 3> kStd  = {0.229f*255, 0.224f*255, 0.225f*255};
m_model = new dl::Model(model_path, location);        // 构造函数内部 load+build
if (m_model->get_inputs().empty() || m_model->get_outputs().empty()) {
    ESP_LOGE("CatDogClassifier", "model has no input/output tensors");
    return;                                            // m_ready 保持 false
}
m_model->minimize();                                   // 删调试变量省内存，之后不能 test()
m_image_preprocessor = new dl::image::ImagePreprocessor(m_model, kMean, kStd);
m_postprocessor = new CatDogPostprocessor(m_model);    // topk=2, thr=0, softmax=true
m_ready = true;
```

`kMean`/`kStd` 必须和训练时完全相同；后处理器用的 `kCatDogLabels = {"cat", "dog"}` 顺序也必须和训练时的类别顺序一致，否则标签张冠李戴。

**3. 主流程与两段耗时（main/app_main.cpp）**

```cpp
int64_t decode_start = esp_timer_get_time();
auto image = dl::image::sw_decode_jpeg(jpeg, dl::image::DL_IMAGE_PIX_TYPE_RGB888);
int64_t decode_us = esp_timer_get_time() - decode_start;   // 解码耗时
heap_caps_free(jpeg_data);                                 // JPEG 缓冲用完即释放
int64_t infer_start = esp_timer_get_time();
auto &results = classifier.run(image);
int64_t infer_us = esp_timer_get_time() - infer_start;     // 推理耗时
const auto &top1 = results.front();
ESP_LOGI(TAG, "top1=%s score=%.6f infer=%lld us", top1.cat_name, top1.score, infer_us);
heap_caps_free(image.data);
bsp_sdcard_unmount();
```

`decode_us` 和 `infer_us` 各用一对时间戳夹住，所以日志里能看到两个独立耗时——这是后续性能分析的基础。读文件用的 `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` 明确从 PSRAM 申请，避免撑爆内部 RAM。

## 关键文件说明

| 文件/目录 | 职责 | 类型 |
|---|---|---|
| [`main/app_main.cpp`](main/app_main.cpp) | 主流程：SD 挂载、读文件、JPEG 解码、调用分类器、打印与释放 | 课程代码 |
| [`main/catdog_classifier.hpp`](main/catdog_classifier.hpp)、[`main/labels.hpp`](main/labels.hpp) | `CatDogClassifier`（加载 + minimize + 预/后处理）与 `CatDogPostprocessor`；`kCatDogLabels = {"cat","dog"}` 是类别顺序契约 | 课程代码/配置 |
| [`main/CMakeLists.txt`](main/CMakeLists.txt)、[`main/idf_component.yml`](main/idf_component.yml) | 注册源文件；声明依赖 `esp-dl`、`esp32_s3_eye`、`esp_timer`（`idf>=5.4`） | 构建/依赖 |
| [`CMakeLists.txt`](CMakeLists.txt)、[`partitions.csv`](partitions.csv)、[`sdkconfig.defaults`](sdkconfig.defaults) | 顶层工程 `catdog_static_infer`（默认 BSP=`esp32_s3_eye`）；factory 分区约 7.8 MB；esp32s3、8 MB flash、八线 PSRAM 80 MHz | 构建配置 |
| `dependencies.lock`、`managed_components/`、`build/` | 版本锁定、自动下载的组件源码、构建产物 | 生成物 |
| `/sdcard/models/s3/*.espdl`、`/sdcard/images/*.jpg` | 板上输入的模型和图片（外部素材，不在仓库内） | 外部素材 |

## 配置说明

| 修改位置 | 配置项 | 现象变化 |
|---|---|---|
| [`main/app_main.cpp`](main/app_main.cpp) | `kModelPath` / `kImagePath` | 改变模型或图片在 SD 卡上的位置，必须和实际拷贝路径一致 |
| [`main/catdog_classifier.hpp`](main/catdog_classifier.hpp) | `kMean` / `kStd` | 归一化参数，**必须与训练一致**，否则结果偏移甚至完全错乱 |
| [`main/labels.hpp`](main/labels.hpp) | `kCatDogLabels` | 标签顺序，**必须与训练类别顺序一致**，否则猫狗互换 |
| `CatDogPostprocessor` 构造 | `topk` / `score_thr` | 改 topk 影响返回条数，改 score_thr 可过滤低分结果 |
| `sdkconfig.defaults` | `CONFIG_FATFS_LFN_HEAP` | **必须开启**（默认 `LFN_NONE`），否则读不了长文件名模型 |
| `sdkconfig.defaults` | `CONFIG_SPIRAM*` | 关闭 PSRAM 后大图片解码/推理会因内存不足失败 |
| `partitions.csv` | `factory` 分区大小 | 改小固件装不下；模型在 SD 卡，flash 主要放固件本身 |

改动 `sdkconfig.defaults`、`partitions.csv` 或组件版本后需重新 `idf.py build`（必要时 `idf.py fullclean`）。

## 术语小表

| 术语 | 解释 |
|---|---|
| BSP / 挂载（mount） | 板级支持包，封装本板 SD 卡、摄像头等硬件访问 / 让固件把 SD 卡识别为目录树，挂载点 `/sdcard` |
| FAT32 / LFN | SD 卡常用文件系统 / 长文件名支持，长名模型文件必须开启 LFN |
| JPEG / RGB888 | 压缩图片格式 / 每像素红绿蓝各 8 位的解码结果 |
| PSRAM | 板载外部大内存，图片缓冲和解码像素都放这里 |
| 预处理 / 推理 | resize 到模型输入尺寸并按训练均值/标准差归一化 / 模型前向计算得到各类别分数 |
| softmax / Top-1 | 把输出转成和为 1 的概率 / 概率最高的那个类别 |
| `minimize()` | 删掉调试用中间变量以省内存，代价是不能再 `test()`/调试 |
| `esp_timer_get_time()` | 微秒级计时，用于分别测解码耗时和推理耗时 |

## 验证清单

- [ ] SD 卡为 FAT32，`models/s3/catdog_mobilenet_v2.espdl` 与 `images/sample.jpg` 已按固定路径放好，并记录了图片来源（不用个人照片）；
- [ ] 已按 B.0 开启长文件名（`grep FATFS_LFN sdkconfig` 显示 `CONFIG_FATFS_LFN_HEAP=y`），`idf.py build` 成功、目标为 `esp32s3`，板上日志出现 `SD card mounted at /sdcard`；
- [ ] 日志能区分**解码耗时**和**推理耗时**两个独立数值；
- [ ] 成功路径打印 `top1=... score=... infer=... us`，标签与实际图片相符；
- [ ] 失败路径（拔卡、错文件名、坏图）都有明确错误输出且不伪造 Top-1，退出前释放像素并卸载 SD 卡。

## 思考题与拓展挑战

**思考题**

1. 为什么模型和图片都从 SD 卡读，而不像微课那样把模型嵌进固件？

   **参考答案：**SD 卡方式换模型、换图片都不用重新编译烧录，适合做多样输入验证；代价是要额外处理挂载失败、文件缺失、读写失败等故障路径。

2. 为什么解码耗时和推理耗时要分开记录？

   **参考答案：**解码耗时主要受图片尺寸和 PSRAM 带宽影响，推理耗时主要受模型结构和 CPU 频率影响；分开测才知道该优化哪一段。

3. `minimize()` 会警告"breaking model testing/debugging"，为什么还要调用它？

   **参考答案：**板端内存紧张，删掉推理用不到的中间变量能省下 PSRAM/内部 RAM 让分类跑起来；牺牲的是事后自检/调试能力，对一次性静态推理来说划算。要在板上做 `test()` 就不能调用它。

**拓展挑战**

- 放两张不同尺寸的猫/狗图片，比较解码耗时和推理耗时，验证"解码耗时随图片尺寸变化、推理耗时基本不变"（都会 resize 到同一输入尺寸）；
- 在 `read_file` 之前增加检查：校验文件大小上限和 JPEG 魔数（文件头 `FF D8 FF`），不合规直接给出清晰错误；
- 在 `images/` 下放多张图循环处理，统计一批图片的分类正确率和平均推理耗时，形成小型测试记录。

