"""Conservative, local intent parsing. This module never creates capture tasks.

No language-model credentials are configured in this project. Keep the parser's
structured contract separate from the two allowlisted browser-side data tools.
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone

from flask import jsonify, request

BEIJING = timezone(timedelta(hours=8))
INTENTS = {"query_existing", "collect_new", "image_capture", "vision_analyze"}
MODES = {"latest", "history", "last_task", "image_existing", "image_fresh"}


def device_aliases(app):
    aliases = app.config.get("ASSISTANT_DEVICE_ALIASES")
    if aliases is None:
        try:
            aliases = json.loads(os.environ.get("IMU_ASSISTANT_DEVICE_ALIASES", "{}"))
        except (ValueError, TypeError):
            raise ValueError("设备别名配置无效，请检查服务端配置。") from None
    if not isinstance(aliases, dict) or any(
        not isinstance(k, str) or not 1 <= len(k) <= 64
        or not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", v)
        for k, v in aliases.items()
    ):
        raise ValueError("设备别名配置无效，请检查服务端配置。")
    return aliases


def time_filters(message, now):
    """Return explicit Beijing receipt-time filters; never silently discard time text."""
    start = end = None
    if re.search(r"早上|上午|下午|晚上|凌晨|中午|傍晚|(?:最近|过去)\s*[一二三四五六七八九十半]+\s*(?:分钟|小时|天)", message):
        raise ValueError("请提供明确的日期和时分范围，或使用数字说明时间长度，例如最近 10 分钟。")
    dates = re.findall(r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?", message)
    if dates:
        if len(dates) > 2:
            raise ValueError("请只提供一个时间范围，例如 2026-09-24 到 2026-09-25。")
        try:
            parsed = [datetime.fromisoformat(d) for d in dates]
        except ValueError:
            raise ValueError("日期或时间无效，请检查月份、日期和时分秒。") from None
        start = parsed[0]
        end = parsed[-1]
        if len(dates[-1]) == 10:
            end += timedelta(days=1, microseconds=-1)
    else:
        relative = re.search(r"(?:最近|过去)\s*(\d+)\s*(分钟|小时|天)", message)
        if relative:
            amount = int(relative[1])
            if not 1 <= amount <= 365:
                raise ValueError("请提供 1 到 365 之间的时间长度。")
            end = now.replace(tzinfo=None)
            start = end - timedelta(seconds=amount * {"分钟": 60, "小时": 3600, "天": 86400}[relative[2]])
        elif any(word in message for word in ("今天", "昨天", "前天")):
            days = [d for word, d in (("今天", 0), ("昨天", 1), ("前天", 2)) if word in message]
            midnight = now.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
            start = midnight - timedelta(days=max(days))
            end = midnight - timedelta(days=min(days)) + timedelta(days=1, microseconds=-1)
        elif re.search(r"\d+\s*[年月日点时分秒]|\d+:\d+|上周|本周|上个月|早上|上午|下午|晚上|之前的?\d", message):
            raise ValueError("请补充明确日期或时间范围，例如 2026-09-24 09:00 到 2026-09-24 18:00，或最近 10 分钟。")
    if dates and len(dates) == 1:
        if re.search(r"截至|截止|之前|以前", message):
            start = None
        elif re.search(r"之后|以后|从|自", message):
            end = None
        elif len(dates[0]) > 10:
            end += timedelta(seconds=1 if len(dates[0]) == 19 else 60, microseconds=-1)
    if start and end and start > end:
        raise ValueError("开始时间不能晚于结束时间，请重新提供时间范围。")
    return {"start": start.isoformat(sep=" ") if start else "",
            "end": end.isoformat(sep=" ") if end else ""}


def interpret(message, context, devices, aliases=None, now=None):
    if not isinstance(message, str) or not message.strip() or len(message) > 500:
        raise ValueError("请输入 1 到 500 个字符的请求。")
    if not isinstance(context, dict) or set(context) - {"device", "pending"}:
        raise ValueError("对话上下文格式无效。")
    current = context.get("device")
    if current is not None and (not isinstance(current, str) or len(current) > 64):
        raise ValueError("设备参数无效。")
    pending = context.get("pending")
    if pending is None:
        pending = {}
    if not isinstance(pending, dict) or set(pending) - {"intent", "mode", "start", "end", "limit", "image_record_id"}:
        raise ValueError("待澄清参数格式无效。")
    if "image_record_id" in pending and (type(pending["image_record_id"]) is not int or not 1 <= pending["image_record_id"] <= 2147483647):
        raise ValueError("待澄清图片编号无效。")
    if pending and (not isinstance(pending.get("intent"), str) or pending["intent"] not in INTENTS
                    or not isinstance(pending.get("mode"), str) or pending["mode"] not in MODES
                    or type(pending.get("limit")) is not int or not 1 <= pending["limit"] <= 100
                    or any(not isinstance(pending.get(k), str) or len(pending[k]) > 32 for k in ("start", "end"))):
        raise ValueError("待澄清参数格式无效。")
    ids = sorted({d["device"] for d in devices})
    names = {identifier: identifier for identifier in ids}
    if "ESP32_S3_EYE" in ids:
        names["ESP32-S3-EYE"] = "ESP32_S3_EYE"
    names.update(aliases or {})
    choices = [{"id": d, "name": "ESP32-S3-EYE" if d == "ESP32_S3_EYE" else d} for d in ids]
    message = message.strip()

    def reply(status, text, params=None, wait=None, device=current):
        return {"status": status, "message": text, "parser": "local_rules",
                "intent": params["intent"] if params else None, "parameters": params,
                "context": {"device": device, "pending": wait}, "devices": choices}

    if message in ("取消", "算了", "停止", "不用了"):
        return reply("clarify", "已取消待澄清的请求。已有采集任务不会因此被取消。")
    if re.search(r"怎么|如何|教程|会怎样|是否支持|能否支持|方法|步骤|示例|例如|比如|假设|用户说", message):
        return reply("clarify", "你可以说“查看上次数据”或“重新采集一次”，并选择或说明设备。")
    if re.search(r"温度|湿度|气压|视频|位置|车间|楼|房间|角速度|陀螺仪|人脸|识别.*人|分析.*人", message):
        return reply("clarify", "当前助手只支持按设备查询或采集三轴加速度；位置和其他数据类型尚无对应工具，请说明实际设备及加速度请求。")
    if re.search(r"明天|后天|定时|每隔|每\d|\d+\s*(?:秒|分钟|小时)后|连续采集|批量采集", message):
        return reply("clarify", "当前只支持查询已有记录或立即采集一次，不支持定时、连续或批量采集。")

    # Remove negated collection clauses before recognizing a new action.
    positive = re.sub(r"(?:不要|别|不用|不需要|无需|不想|不是|不)\s*(?:重新|再|现在)?\s*采(?:集|样)?[^，,。；;]*", "", message)
    vision = bool(re.search(r"(?:分析|判断|检查).*(?:图片|照片|画面|环境图)|(?:图片|照片|画面|环境图).*(?:能用|是否可用|可用吗|是否清晰|清晰吗|是否.*遮挡|有没有遮挡|画质如何)", positive))
    if vision and re.search(r"如果|假如|等到|已经|昨天|前天|多张|所有|每张|历史|对比|比较|数据|采集一次", positive):
        return reply("clarify", "请在具体图片下点击“分析这张图片”，或明确说“看看当前画面是否可用”拍摄并分析一张新图。")
    if vision and (re.search(r"(?:不|别)\s*(?:分析|判断|检查)", positive) or
                   (re.search(r"当前|现在|重新拍", positive) and re.search(r"刚才|上次|之前", positive))):
        return reply("clarify", "不会自动拍摄或分析；请明确指定已有图片，或请求拍摄当前画面。")
    image = bool(re.search(r"拍(?:摄)?(?:一张|张|一下)?(?:现在的|当前的)?(?:环境)?(?:图片|照片|图)|拍照|(?:看一下|看看|查看|获取)(?:现在|当前)的?环境|(?:获取|查看|看看|看一下)(?:当前|现在)的?画面", positive))
    if vision:
        image = False  # Inference is distinct from capture; mode below decides whether to take a new frame.
    if re.search(r"照片|图片|环境图|画面|摄像头", positive) and not image and not vision:
        return reply("clarify", "若要现在拍摄一张新照片，请说“拍一张照片”。不会用历史图片代替本次拍摄。")
    if image and re.search(r"如果|假如|等到|要不要|是否|已经|刚刚|还没|尚未|没有|不能|不拍|不是|禁止|避免|上次|历史|之前|昨天|连续|多张|[两二三四五六七八九十2-9]张", message):
        return reply("clarify", "请明确是否现在拍摄一张新照片；不会自动连续拍照，也不会将历史图片作为本次结果。")
    query = bool(re.search(r"查看|查询|查一下|查下|看看|看一下|上次|刚才|历史|之前|已有|旧数据", positive))
    if vision:
        query = False
    if image and not re.search(r"数据|结果|历史|上次|刚才", positive):
        query = False
    collect = bool(re.search(r"重新\s*采(?:集|样)?|再\s*采(?:集|样)?(?:一[次遍])?|(?:现在|立即|马上)\s*采(?:集|样)?|获取\s*最新数据|采(?:集|样)\s*一次", positive))
    if positive != message and not query and not collect and not image:
        return reply("clarify", "不会触发新采集。若要查看已有记录，请说明查询请求。")
    if collect and re.search(r"如果|假如|等到|要不要|是否|已经|刚刚|还没|尚未|没有|不能|禁止|避免", message):
        return reply("clarify", "请确认是否现在重新采集一次；条件、询问或过去的操作描述不会触发新任务。")
    if collect and re.search(r"(?:[2-9]\d*|两|二|三|四|五|多)\s*[次遍]", positive):
        return reply("clarify", "当前只支持一次采集，请明确是否重新采集一次。")
    # Question/negation, multiple actions and comparisons are not authorization.
    if re.search(r"不要|别|不用|不需要|无需|不想|还是|或者|对比|比较", positive) or sum((query, collect, image)) > 1:
        return reply("clarify", "请明确选择：查询已有数据，还是重新采集一次？")
    intent = "vision_analyze" if vision else "image_capture" if image else "collect_new" if collect else "query_existing" if query else pending.get("intent")

    matched = set()
    for name, device in names.items():
        pattern = re.escape(name)
        if name.isascii():
            pattern = rf"(?<![A-Za-z0-9_-]){pattern}(?![A-Za-z0-9_-])"
        if re.search(pattern, message, re.IGNORECASE):
            matched.add(device)
    unknown = re.findall(r"[一二三四五六七八九十\d]+号设备|(?:设备(?:ID|编号)?\s*[:：]?\s*)([A-Za-z0-9_-]+)", message, re.IGNORECASE)
    ordinal = re.findall(r"[一二三四五六七八九十\d]+号设备", message)
    tokens = [token for token in re.findall(r"(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9_-]*[0-9_-][A-Za-z0-9_-]*", message)
              if token.casefold() != "qma6100p"]
    explicit = [x for x in unknown if x] + ordinal + tokens
    device_question = None
    for hint in explicit:
        matches = {value for name, value in names.items() if name.casefold() == hint.casefold()}
        if not matches:
            if hint.endswith("号设备"):
                device_question = f"尚未配置“{hint}”与实际设备的对应关系，请选择设备或提供完整设备 ID。"
                continue
            return reply("invalid", f"设备“{hint}”不存在，请核对设备 ID。", device=None)
        matched.update(matches)
    if len(matched) > 1:
        device_question = "请求中包含多个设备，请选择本次要操作的一个设备。"
    device = None if device_question else next(iter(matched)) if matched else current
    if device is not None and device not in ids:
        return reply("invalid", f"设备“{device}”不存在，请核对设备 ID。", device=None)
    if not intent:
        return reply("clarify", "你想查询已有数据，还是重新采集一次？", device=device)
    mode = "history" if re.search(r"历史|之前|过去|昨天|今天|前天|最近\s*\d", message) else "latest"
    if re.search(r"(?:上次|刚才|本次|这次).*(?:采集.*(?:结果|数据)|结果)|本次任务|这次任务", message):
        mode = "last_task"
    try:
        times = time_filters(message, now or datetime.now(BEIJING))
    except ValueError as error:
        return reply("clarify", str(error), device=device,
                     wait={"intent": intent, "mode": "history", "start": "", "end": "", "limit": 20})
    if not query and not collect and not image and not vision and pending and not (matched or times["start"] or times["end"] or re.search(r"\d+\s*条", message)
                                                     or message in ("确认", "当前设备", "这个设备", "使用当前设备")):
        return reply("clarify", "请提供明确的设备 ID，或选择设备后回复“确认”。", wait=pending, device=device)
    if times["start"] or times["end"]:
        mode = "history"
    limit_match = re.search(r"(?:最近|前|最后)?\s*(\d+)\s*条", message)
    limit = int(limit_match[1]) if limit_match else 20
    if not 1 <= limit <= 100:
        return reply("clarify", "每次可查询 1 到 100 条记录，请说明需要的条数。", device=device,
                     wait={"intent": intent, "mode": "history", **times, "limit": 20})
    if limit_match:
        mode = "history"
    if not query and not collect and not image and not vision and pending:
        if not limit_match:
            limit = pending["limit"]
        if not times["start"] and not times["end"] and not limit_match:
            mode = pending["mode"]
        if not times["start"] and not times["end"]:
            times = {key: pending[key] for key in ("start", "end")}
    if intent in ("collect_new", "image_capture") and (times["start"] or times["end"] or limit_match or re.search(r"历史|之前|过去", message)):
        return reply("clarify", "重新采集只能取得本次读数。若要历史记录，请明确说“查询历史数据”。", device=device)
    params = {"intent": intent, "mode": mode if intent == "query_existing" else "latest",
              **times, "limit": limit}
    if intent == "vision_analyze":
        params["mode"] = ("image_fresh" if re.search(r"当前|现在|重新拍", positive) else "image_existing") if vision else pending["mode"]
    if intent == "vision_analyze":
        image_ids = re.findall(r"(?:图片|照片)(?:记录|编号)?\s*[#：:]?\s*(\d+)", positive)
        if image_ids:
            if len(image_ids) != 1 or not 1 <= int(image_ids[0]) <= 2147483647 or params["mode"] == "image_fresh":
                return reply("clarify", "请只指定一张已有图片的记录编号，或单独请求拍摄当前画面。", device=device)
            params["image_record_id"] = int(image_ids[0])
        elif not vision and "image_record_id" in pending:
            params["image_record_id"] = pending["image_record_id"]
    if device_question:
        return reply("clarify", device_question, wait=params, device=None)
    if device is None:
        return reply("clarify", "请说明要操作的设备，或在上方选择设备。", wait=params, device=None)
    params.update(device=device, data_type="image" if intent in ("image_capture", "vision_analyze") else "acceleration")
    return reply("ready", "已识别请求。", params=params, device=device)


def register_assistant(app, list_devices):
    @app.post("/api/assistant/interpret")
    def assistant_interpret():
        if not request.is_json:
            return jsonify(error="Content-Type must be application/json."), 415
        body = request.get_json()
        if not isinstance(body, dict) or set(body) - {"message", "context"}:
            raise ValueError("请求只能包含 message 和 context。")
        return jsonify(interpret(body.get("message"), body.get("context", {}),
                                 list_devices(), device_aliases(app)))
