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
