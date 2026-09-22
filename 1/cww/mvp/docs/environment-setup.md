# 环境搭建

本课程需要两条互相独立的工具链：**Python 线**（主机上训练与量化模型）和 **IDF 线**（ESP32 上构建与运行固件）。

| 工具链 | 用途 | 关键工具 |
|---|---|---|
| Python 线 | 训练、导出 ONNX、量化为 `.espdl` | conda `esp32s3` 环境 + PyTorch + ESP-PPQ |
| IDF 线 | 构建 ESP32 固件、烧录、串口观察 | ESP-IDF v5.4.x + `idf.py` |

## 硬件

- ESP32-S3-EYE 开发板（OV2640 摄像头、麦克风、LCD、MicroSD 槽、按键）
- ESP-SR 语音识别模型库。
- USB-C 数据线（注意：部分线材只能充电不能传数据）
- 串口设备名（macOS）：`/dev/cu.usbmodem*` 或 `/dev/cu.wchusbserial*`

确认串口设备：

```bash
ls /dev/cu.*
```

## IDF 线：ESP-IDF

推荐版本 **v5.4.x**（本工程在 v5.4.3 上验证）。当前终端能够找到 ESP-IDF 后，直接验证：

```bash
idf.py --version        # 应显示 v5.4.x
```

如果当前终端找不到 `idf.py`，先执行 ESP-IDF 安装目录中的环境脚本（路径按实际安装位置调整）：

```bash
. <ESP-IDF安装目录>/export.sh
idf.py --version
```

若尚未安装，参考官方指南安装 ESP-IDF v5.4：
<https://docs.espressif.com/projects/esp-idf/zh_CN/v5.4.3/esp32s3/get-started/index.html>

> ⚠️ 首次 `idf.py build` 会联网从组件注册表拉取 `espressif/esp-dl` 等依赖到 `managed_components/`，需要网络。

语音案例还需要 ESP-SR 组件。第 5～8 集固定模型和默认参数写入项目文本配置，不要求通过 menuconfig 操作。

## Python 线：conda 环境

```bash
# 创建环境（Python 3.11 已验证）
conda create -n esp32s3 python=3.11
conda activate esp32s3

# 安装第 1 集依赖
pip install -r microcourses/01_train_sin_model/requirements.txt

# 验证
python -c "import esp_ppq, torch, onnx, onnxsim; print('env ok', torch.__version__)"
```

## 构建第 2 集固件（最小命令序列）

```bash
cd microcourses/03_run_sin_model
idf.py --version
idf.py set-target esp32s3        # 首次或切换目标时
idf.py build
idf.py size                      # 查看二进制与内存占用
# 有硬件时：
idf.py -p <PORT> flash monitor
```

## 坚果云同步注意

本仓库位于坚果云同步目录内。`build/`、`managed_components/` 已被 `.gitignore` 忽略，但文件数量较多，
若同步压力大，可在坚果云客户端侧忽略这些目录。如遇 `*-NSConflict-*` 冲突文件，按父仓库习惯处理即可。
