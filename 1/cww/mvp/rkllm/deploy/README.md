# Orange Pi Qwen2-VL service

The RKLLama service runs on the Orange Pi 5 Plus at:

- Base URL: `http://192.168.100.144:8080`
- Model: `qwen2-vl:2b`
- Ollama API: `POST /api/chat`
- OpenAI API: `POST /v1/chat/completions`

List the available models:

```bash
curl http://192.168.100.144:8080/api/tags
```

Run the included Ollama-compatible image test:

```bash
./deploy/test-qwen2-vl.sh /path/to/image.jpg
```

The argument may be a local path, an HTTP URL, or a base64 data URL. To use an
OpenAI-compatible client, set its base URL to `http://192.168.100.144:8080/v1`.
RKLLama does not require an API key, but clients that require a value can use
any non-empty placeholder.

Service administration on the Orange Pi:

```bash
sudo systemctl status rkllama
sudo systemctl restart rkllama
journalctl -u rkllama -f
```
