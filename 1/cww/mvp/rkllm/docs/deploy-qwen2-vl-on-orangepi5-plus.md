# 在 Orange Pi 5 Plus 上部署 Qwen2-VL，并向局域网提供 API 服务

本文面向第一次接触 Orange Pi、Linux 服务和 RKNN/RKLLM 的用户。完成后，你会得到一个运行在 Orange Pi 5 Plus NPU 上的 Qwen2-VL-2B 服务，并可以从同一局域网内的电脑、手机或其他应用通过 Ollama/OpenAI 兼容接口访问。

本文中的方案已经在以下环境中实际部署和验证：

| 项目 | 测试环境 |
| --- | --- |
| 开发板 | Orange Pi 5 Plus，RK3588 |
| 内存 | 8 GB RAM，4 GB Swap |
| 系统 | Ubuntu 22.04 / Orange Pi OS，aarch64 |
| 内核 | Linux 6.1.43-rockchip-rk3588 |
| Python | 3.10.12 |
| RKNPU 驱动 | v0.9.6 |
| RKLLama | 0.0.75 |
| RKLLM Runtime | 1.3.0 |
| RKNN Runtime | 2.3.2 |
| 模型 | Qwen2-VL-2B-Instruct，RKLLM + RKNN |
| API 端口 | 8080 |

## 1. 部署架构

Qwen2-VL 在 RK3588 上由两部分组成：

1. `Qwen2-VL-2B-Instruct.rkllm`：语言模型，由 RKLLM Runtime 调用 NPU 执行。
2. `qwen2_vl_2b_vision_rk3588.rknn`：视觉编码器，由 RKNN Runtime 调用 NPU 执行。

RKLLama 负责加载这两个模型，并提供以下接口：

- Ollama 兼容接口：`http://开发板IP:8080/api`
- OpenAI 兼容接口：`http://开发板IP:8080/v1`

相关项目：

- RKLLM 官方项目：[airockchip/rknn-llm](https://github.com/airockchip/rknn-llm)
- RKLLama 服务项目：[NotPunchnox/rkllama](https://github.com/NotPunchnox/rkllama)
- 本文使用的预转换模型：[3ib0n/Qwen2-VL-2B-rkllm](https://huggingface.co/3ib0n/Qwen2-VL-2B-rkllm)
- 原始模型：[Qwen/Qwen2-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct)

## 2. 准备工作

建议准备：

- Orange Pi 5 Plus，至少 8 GB 内存。
- 质量可靠的电源和散热器。
- 至少 10 GB 可用磁盘空间，建议使用容量更大的 eMMC、NVMe 或 SD 卡。
- 64 位 Ubuntu/Orange Pi OS。
- 一台与 Orange Pi 位于同一局域网的电脑。
- 可以访问 GitHub、PyPI 和 Hugging Face 的网络。

本文假设开发板信息如下：

```text
用户名: orangepi
开发板 IP: 192.168.100.144
API 端口: 8080
```

请把教程中的 `192.168.100.144` 替换为你自己的开发板 IP。

## 3. 通过 SSH 登录开发板

在 Windows PowerShell、macOS Terminal 或 Linux 终端执行：

```bash
ssh orangepi@192.168.100.144
```

首次连接时输入 `yes` 接受主机指纹，然后输入开发板密码。Orange Pi 镜像的默认密码经常是 `orangepi`，实际以你的镜像设置为准。

登录成功后，建议立即修改默认密码：

```bash
passwd
```

后续标记为“在 Orange Pi 上执行”的命令，都应在这个 SSH 终端中运行。

如果不知道开发板 IP，可以在开发板本地终端执行：

```bash
ip -br addr
```

找到类似 `192.168.x.x/24` 的地址。

## 4. 检查系统、内存和存储空间

在 Orange Pi 上执行：

```bash
uname -a
uname -m
cat /etc/os-release
python3 --version
free -h
df -h /
```

确认：

- `uname -m` 输出 `aarch64`。
- Python 版本为 3.9 至 3.12；本文按 Python 3.10 编写。
- 可用内存接近 8 GB 或更多。
- 根目录至少有 10 GB 可用空间。

## 5. 检查 RKNPU 驱动

执行：

```bash
sudo cat /sys/kernel/debug/rknpu/version
```

本文测试板输出：

```text
RKNPU driver: v0.9.6
```

建议驱动版本不低于 `v0.9.6`。如果文件不存在，可以先确认 debugfs 是否挂载：

```bash
mount | grep debugfs
```

必要时执行：

```bash
sudo mount -t debugfs none /sys/kernel/debug
sudo cat /sys/kernel/debug/rknpu/version
```

如果驱动版本太旧，优先升级 Orange Pi 官方系统镜像或内核。初学者不建议单独替换内核 `.ko` 文件，因为内核、驱动和设备树不匹配可能导致 NPU 不可用。

## 6. 安装系统依赖

在 Orange Pi 上执行：

```bash
sudo apt-get update
sudo apt-get install -y \
  git \
  curl \
  jq \
  file \
  ca-certificates \
  python3.10-venv
```

如果系统不是 Python 3.10，把最后一个包换成对应版本，例如 `python3.11-venv`，也可以尝试通用包：

```bash
sudo apt-get install -y python3-venv
```

## 7. 下载 RKLLama

在 Orange Pi 上执行：

```bash
cd /home/orangepi
git clone --depth 1 https://github.com/NotPunchnox/rkllama.git
cd /home/orangepi/rkllama
```

记录当前版本，便于以后排查问题：

```bash
git rev-parse HEAD
```

本文实际测试的提交为：

```text
76bda5a4daf143babcd3e9a3d69e63f879c86e04
```

## 8. 创建 Python 虚拟环境

使用独立虚拟环境可以避免污染系统 Python：

```bash
cd /home/orangepi/rkllama
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip wheel 'setuptools<82'
```

如果出现 `ensurepip is not available`，说明还没有安装 venv 包。重新执行第 6 节中的 `python3.10-venv` 安装命令，然后删除失败的环境并重建：

```bash
rm -rf .venv
python3 -m venv .venv
```

## 9. 安装 Qwen2-VL 所需的 RKLLama 依赖

RKLLama 的完整依赖还包含语音识别、语音合成和图像生成组件。本文只部署 Qwen2-VL，所以安装已经验证过的最小依赖集合，可以减少下载量和内存占用。

首先安装 RKLLama 本身：

```bash
cd /home/orangepi/rkllama
.venv/bin/python -m pip install --no-deps .
```

安装 Web 服务、Tokenizer 和图像处理依赖：

```bash
.venv/bin/python -m pip install \
  Flask==2.3.2 \
  requests==2.31.0 \
  huggingface_hub==0.35.1 \
  python-dotenv==1.1.1 \
  transformers==4.57.6 \
  flask-cors==6.0.1 \
  psutil==7.1.0 \
  pillow==11.3.0 \
  numpy==1.26.4 \
  opencv-python-headless==4.11.0.86
```

安装仓库中附带的 RKNN Toolkit Lite 运行包。Python 3.10 使用以下文件：

```bash
.venv/bin/python -m pip install \
  src/rkllama/lib/rknn_toolkit_lite2-2.3.2-cp310-cp310-manylinux_2_17_aarch64.manylinux2014_aarch64.whl
```

如果使用 Python 3.9、3.11 或 3.12，请先查看仓库中的 wheel：

```bash
ls src/rkllama/lib/rknn_toolkit_lite2-*.whl
```

然后选择文件名中 `cp39`、`cp311` 或 `cp312` 对应的版本。

测试关键模块能否导入：

```bash
.venv/bin/python -c "import rkllama.server.server; import cv2; from rknnlite.api import RKNNLite; print('RKLLama import OK', cv2.__version__)"
```

成功时可以看到：

```text
RKLLama import OK 4.11.0
```

可能同时看到下面的提示：

```text
None of PyTorch, TensorFlow >= 2.0, or Flax have been found.
```

本文部署使用 RKNN/RKLLM NPU Runtime，不使用 PyTorch 执行模型，所以该提示不影响 Qwen2-VL 推理。

由于采用最小依赖安装，`pip check` 还可能提示缺少 diffusers、whisper、piper-tts 或 torch。这些包对应未启用的图像生成和语音接口，不影响本文的视觉问答服务。

## 10. 创建模型目录

执行：

```bash
cd /home/orangepi/rkllama
mkdir -p 'models/qwen2-vl:2b'
mkdir -p data/huggingface logs
```

目录名中的 `:` 是模型标签的一部分，因此建议使用单引号包裹路径。

## 11. 下载 Qwen2-VL 的 RKLLM 和 RKNN 模型

模型文件合计约 3.43 GB。执行：

```bash
cd /home/orangepi/rkllama

.venv/bin/hf download \
  3ib0n/Qwen2-VL-2B-rkllm \
  Qwen2-VL-2B-Instruct.rkllm \
  qwen2_vl_2b_vision_rk3588.rknn \
  --local-dir 'models/qwen2-vl:2b'
```

下载中断后可以执行同一条命令继续，Hugging Face 客户端会尽量复用已下载的数据。

下载完成后检查文件：

```bash
ls -lh 'models/qwen2-vl:2b'
stat -c '%n %s bytes' 'models/qwen2-vl:2b/'*.rkllm 'models/qwen2-vl:2b/'*.rknn
```

本文测试文件的精确大小为：

```text
Qwen2-VL-2B-Instruct.rkllm 2035398748 bytes
qwen2_vl_2b_vision_rk3588.rknn 1391014138 bytes
```

可以进一步计算 SHA-256：

```bash
cd '/home/orangepi/rkllama/models/qwen2-vl:2b'
sha256sum Qwen2-VL-2B-Instruct.rkllm qwen2_vl_2b_vision_rk3588.rknn
```

本文测试结果：

```text
d476c790768f6b1d9041604bb3205cc299f186cbcb06d81941661797d12df5b0  Qwen2-VL-2B-Instruct.rkllm
ec311f2cc37c3926aa64ace5ead7d4809641fcadf8cb063c2f5ceb33dea5aab7  qwen2_vl_2b_vision_rk3588.rknn
```

## 12. 创建 Modelfile

RKLLama 通过 `Modelfile` 知道语言模型文件、Tokenizer、图片尺寸和视觉 Token 配置。

执行：

```bash
cat > '/home/orangepi/rkllama/models/qwen2-vl:2b/Modelfile' <<'EOF'
FROM="Qwen2-VL-2B-Instruct.rkllm"
HUGGINGFACE_PATH="Qwen/Qwen2-VL-2B-Instruct"

SYSTEM="You are a helpful vision assistant. Answer in the language used by the user."

NUM_CTX=1024
MAX_NEW_TOKENS=256
TEMPERATURE=0.5
TOP_K=7
TOP_P=0.5
REPEAT_PENALTY=1.1

IMAGE_WIDTH=392
IMAGE_HEIGHT=392
N_IMAGE_TOKENS=196
IMG_START=<|vision_start|>
IMG_END=<|vision_end|>
IMG_CONTENT=<|image_pad|>
EOF
```

这里将上下文限制为 1024、最大输出限制为 256，以降低 8 GB 开发板同时加载视觉编码器和语言模型时的内存压力。

如果发生内存不足，可以进一步修改为：

```text
NUM_CTX=512
MAX_NEW_TOKENS=128
```

## 13. 可选：预下载官方 Tokenizer

第一次推理时，RKLLama 会从 `Qwen/Qwen2-VL-2B-Instruct` 下载 Tokenizer。为了避免第一次请求等待，可以提前下载：

```bash
cd /home/orangepi/rkllama

HF_HOME=/home/orangepi/rkllama/data/huggingface \
  .venv/bin/python - <<'PY'
from transformers import AutoTokenizer

AutoTokenizer.from_pretrained(
    "Qwen/Qwen2-VL-2B-Instruct",
    trust_remote_code=True,
)
print("Tokenizer download complete")
PY
```

## 14. 创建 systemd 服务

systemd 可以让 RKLLama 在后台运行、异常退出时重启，并在 Orange Pi 重启后自动启动。

执行：

```bash
sudo tee /etc/systemd/system/rkllama.service > /dev/null <<'EOF'
[Unit]
Description=RKLLama Qwen2-VL server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orangepi
Group=orangepi
WorkingDirectory=/home/orangepi/rkllama
Environment=HOME=/home/orangepi
Environment=HF_HOME=/home/orangepi/rkllama/data/huggingface
Environment=TOKENIZERS_PARALLELISM=false
Environment=RKLLM_LOG_LEVEL=1
ExecStart=/home/orangepi/rkllama/.venv/bin/rkllama_server --processor rk3588 --models /home/orangepi/rkllama/models --port 8080
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
LimitNOFILE=102400

[Install]
WantedBy=multi-user.target
EOF
```

加载配置并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rkllama.service
```

检查状态：

```bash
systemctl is-active rkllama.service
systemctl is-enabled rkllama.service
sudo systemctl --no-pager --full status rkllama.service
```

正确结果应包含：

```text
active
enabled
Running on http://0.0.0.0:8080
```

确认端口正在监听：

```bash
ss -ltn | grep ':8080'
```

应该看到类似：

```text
LISTEN 0 0 0.0.0.0:8080 0.0.0.0:*
```

## 15. 配置防火墙

先检查 UFW 是否启用：

```bash
sudo ufw status
```

如果状态为 `active`，只向本地网段开放 8080。例如局域网是 `192.168.100.0/24`：

```bash
sudo ufw allow from 192.168.100.0/24 to any port 8080 proto tcp
```

RKLLama 默认没有 API 身份验证。不要在路由器上把 8080 端口映射到公网，也不要对不可信网络开放该端口。

## 16. 在 Orange Pi 本机验证服务

执行：

```bash
curl http://127.0.0.1:8080/
```

应该返回欢迎信息。

列出模型：

```bash
curl http://127.0.0.1:8080/api/tags | jq
```

结果中应该包含：

```json
{
  "model": "qwen2-vl:2b"
}
```

## 17. 从局域网电脑测试 Ollama 接口

退出 SSH，回到你的电脑终端。先测试网络接口：

```bash
curl http://192.168.100.144:8080/api/tags | jq
```

然后使用网络图片进行视觉问答：

```bash
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -X POST http://192.168.100.144:8080/api/chat \
  -d '{
    "model": "qwen2-vl:2b",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "请用中文描述这张图片。",
        "images": [
          "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/coco_sample.png"
        ]
      }
    ],
    "options": {
      "num_predict": 128,
      "temperature": 0.2
    }
  }' | jq -r '.message.content'
```

第一次请求需要加载模型，可能等待几十秒。后续请求通常会更快。

如果不加最后的 `jq -r '.message.content'`，JSON 中的中文可能显示为：

```text
\u8fd9\u5f20\u56fe\u7247
```

这不是乱码，而是 JSON Unicode 转义。使用 `jq -r` 后会显示正常中文。

## 18. 使用本地图片测试

可以在局域网电脑上创建一个测试脚本。该电脑需要安装 `curl`、`jq`、`file` 和 `base64`。macOS 通常已经带有除 `jq` 外的其他命令；macOS 可以用 `brew install jq` 安装 `jq`，Ubuntu/Debian 可以用 `sudo apt-get install jq file` 安装。

在电脑终端中进入你准备保存脚本的目录，然后执行：

```bash
mkdir -p deploy

cat > deploy/test-qwen2-vl.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

server="${RKLLAMA_URL:-http://192.168.100.144:8080}"
image_source="${1:-https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/coco_sample.png}"

if [[ -f "$image_source" ]]; then
  mime_type="$(file --brief --mime-type "$image_source")"
  image_source="data:${mime_type};base64,$(base64 < "$image_source" | tr -d '\n')"
fi

curl --fail-with-body --no-buffer \
  --silent --show-error \
  -H 'Content-Type: application/json' \
  -X POST "${server}/api/chat" \
  -d "$(jq -n \
    --arg image "$image_source" \
    '{
      model: "qwen2-vl:2b",
      stream: false,
      messages: [{role: "user", content: "Describe this image in Chinese.", images: [$image]}],
      options: {num_predict: 128, temperature: 0.2}
    }')" \
  | jq -r 'if .message.content then .message.content elif .error then "Error: \(.error)" else . end'
EOF

chmod +x deploy/test-qwen2-vl.sh
```

本项目工作区中也已经提供了相同的测试脚本：

```text
deploy/test-qwen2-vl.sh
```

在保存该脚本的电脑上执行：

```bash
chmod +x deploy/test-qwen2-vl.sh
./deploy/test-qwen2-vl.sh /path/to/image.jpg
```

例如：

```bash
./deploy/test-qwen2-vl.sh ./deploy/HBO.jpeg
```

脚本会把本地图片转换为 base64 data URL，发送到 Orange Pi，并直接输出解码后的中文回答。

如果 Orange Pi 使用了不同 IP，可以临时覆盖地址：

```bash
RKLLAMA_URL=http://192.168.1.50:8080 \
  ./deploy/test-qwen2-vl.sh /path/to/image.jpg
```

对于非常大的图片，建议先缩小到几 MB 以内。视觉编码器最终会将图片处理为 392 x 392，因此发送超高分辨率原图通常不会带来明显收益。

## 19. 测试 OpenAI 兼容接口

执行：

```bash
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -X POST http://192.168.100.144:8080/v1/chat/completions \
  -d '{
    "model": "qwen2-vl:2b",
    "stream": false,
    "max_tokens": 64,
    "temperature": 0.2,
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Describe this image in one short English sentence."
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/coco_sample.png"
            }
          }
        ]
      }
    ]
  }' | jq -r '.choices[0].message.content'
```

本文验证时返回：

```text
Two cats are sleeping on a pink couch with remote controls nearby.
```

## 20. 连接 OpenAI SDK、OpenWebUI 或其他客户端

OpenAI 兼容客户端使用：

```text
Base URL: http://192.168.100.144:8080/v1
API Key: 任意非空占位值
Model: qwen2-vl:2b
```

RKLLama 当前不校验 API Key，但部分客户端强制要求填写，可以使用 `rkllama` 等任意非空字符串。

Ollama 兼容客户端使用：

```text
Ollama URL: http://192.168.100.144:8080
Model: qwen2-vl:2b
```

不同客户端对多模态消息格式的支持程度不同。如果客户端不能发送图片，先使用第 17 至 19 节的 curl 命令确认服务端本身正常。

## 21. 日常服务管理

查看状态：

```bash
sudo systemctl status rkllama
```

实时查看日志：

```bash
journalctl -u rkllama -f
```

重启服务：

```bash
sudo systemctl restart rkllama
```

停止服务：

```bash
sudo systemctl stop rkllama
```

重新启动：

```bash
sudo systemctl start rkllama
```

关闭开机自启：

```bash
sudo systemctl disable rkllama
```

查看服务资源占用：

```bash
systemctl show rkllama.service -p MainPID -p MemoryCurrent -p NRestarts
free -h
```

查看当前 NPU 负载：

```bash
sudo cat /sys/kernel/debug/rknpu/load
```

该值是瞬时负载。推理结束后看到 0% 是正常的，需要在请求执行过程中重复查看才能观察到负载。

## 22. 常见问题

### 22.1 局域网无法访问 8080

先在 Orange Pi 上检查：

```bash
systemctl is-active rkllama
ss -ltn | grep ':8080'
curl http://127.0.0.1:8080/api/tags
```

如果本机可访问但其他设备不可访问，检查：

```bash
sudo ufw status
ip -br addr
```

同时确认客户端和 Orange Pi 在同一网段，并确认路由器没有启用 AP 隔离或访客网络隔离。

### 22.2 服务启动失败

查看最近日志：

```bash
journalctl -u rkllama --since '10 minutes ago' --no-pager
```

检查路径：

```bash
ls -l /home/orangepi/rkllama/.venv/bin/rkllama_server
ls -lh '/home/orangepi/rkllama/models/qwen2-vl:2b'
```

### 22.3 模型下载中断

重新执行第 11 节的 `.venv/bin/hf download` 命令。不要删除 `.cache/huggingface` 下的临时文件，否则可能失去断点数据。

还应检查时间和磁盘：

```bash
timedatectl
df -h /
```

### 22.4 提示 `RKNN_ERR_MODEL_INVALID` 或 dynamic range 查询失败

日志可能出现：

```text
Query dynamic range failed. Ret code: RKNN_ERR_MODEL_INVALID.
RKNN model is static shape type
```

本文的视觉编码器是固定 392 x 392 输入的静态模型。只要图片推理能正常返回，这个 dynamic range 查询警告可以忽略。

### 22.5 请求超时或内存不足

将 `Modelfile` 中参数降低为：

```text
NUM_CTX=512
MAX_NEW_TOKENS=128
```

然后重启：

```bash
sudo systemctl restart rkllama
```

检查是否发生 OOM：

```bash
journalctl -k --since '10 minutes ago' | grep -Ei 'oom|out of memory|killed process'
```

不要在 8 GB 开发板上同时运行多个大模型或其他高内存任务。

### 22.6 返回的中文是 `\uXXXX`

这是 JSON Unicode 转义，不是模型乱码。使用：

```bash
curl ... | jq -r '.message.content'
```

OpenAI 接口使用：

```bash
curl ... | jq -r '.choices[0].message.content'
```

### 22.7 修改 Modelfile 后没有生效

模型参数在加载时读取。修改后重启服务：

```bash
sudo systemctl restart rkllama
```

然后重新发送请求。

## 23. 部署结果检查清单

完成部署后，应满足以下条件：

- `sudo cat /sys/kernel/debug/rknpu/version` 显示不低于 v0.9.6 的驱动。
- 两个模型文件大小和校验值正确。
- `systemctl is-active rkllama` 返回 `active`。
- `systemctl is-enabled rkllama` 返回 `enabled`。
- `ss -ltn | grep ':8080'` 显示监听 `0.0.0.0:8080`。
- `curl http://开发板IP:8080/api/tags` 能看到 `qwen2-vl:2b`。
- Ollama `/api/chat` 可以返回图片描述。
- OpenAI `/v1/chat/completions` 可以返回图片描述。
- Orange Pi 重启后服务可以自动恢复。

完成以上检查后，Qwen2-VL 就已经在 Orange Pi 5 Plus 上通过 RK3588 NPU 运行，并可以供局域网设备使用。
