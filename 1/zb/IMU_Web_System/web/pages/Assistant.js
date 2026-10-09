import { element, dateTime } from "../lib/format.js";
import { DataTable } from "../components/DataTable.js";
import { ImageViewer } from "../components/ImageViewer.js";
import { AssistantSession } from "../services/assistantSession.js";
import { AssistantVoice } from "../services/assistantVoice.js";
import { pageShell } from "./shared.js";

let conversation;
export function mount(container, { api }) {
  conversation ||= new AssistantSession(api);
  const root = pageShell("智能助手", "数据查询与设备采集");
  const panel = element(`<section class="panel assistant-panel">
    <label class="assistant-device">本次设备<select aria-label="助手设备"><option value="">请选择设备，也可在对话中说明</option></select></label>
    <p class="assistant-inventory subtle" role="status"></p>
    <div class="assistant-examples" aria-label="输入示例"><button type="button" class="pause-button" data-request="查看上次数据">查看上次数据</button><button type="button" class="pause-button" data-request="看看刚才采集的结果">查看刚才结果</button><button type="button" class="pause-button" data-request="查询今天的历史数据">查询今天历史</button><button type="button" class="pause-button" data-request="重新采集一次">重新采集一次</button></div>
    <section class="assistant-voice" aria-label="按键说话与语音播报">
      <div class="assistant-voice-actions"><button type="button" class="pause-button assistant-voice-start">开始说话</button><button type="button" class="pause-button assistant-voice-stop" disabled>结束说话</button><button type="button" class="pause-button assistant-speak-stop" disabled>停止播报</button><label><input class="assistant-auto-speak" type="checkbox" checked> 自动播报回答</label></div>
      <p class="assistant-asr-status" role="status"></p>
      <p class="assistant-transcript" hidden>识别：<span></span></p>
      <details class="assistant-voice-details"><summary>语音说明</summary>
      <p class="subtle">音频来自电脑/浏览器麦克风，运行于 Web 端；识别可能使用浏览器厂商的在线服务。单次最长 30 秒，不持续监听。</p>
      <p class="subtle">结束后识别文字自动进入原助手；快捷操作只填入输入框。查询只读已有记录，重新采集会创建新任务。</p>
      <p class="assistant-asr-detail subtle"></p>
      <div class="assistant-voice-actions"><button type="button" class="pause-button assistant-speak" disabled>播报最新回答</button></div>
      <p class="assistant-tts-status" role="status"></p>
      </details>
    </section>
    <details class="assistant-visual-settings"><summary>视觉询问设置</summary><label>忽略后冷却 <input type="number" min="1" max="3600" step="1" aria-label="视觉询问冷却秒数"> 秒</label><button type="button" class="pause-button">保存</button><span class="subtle" role="status"></span></details>
    <div class="assistant-messages" role="log" aria-label="助手对话" aria-live="polite" tabindex="0"></div>
    <button type="button" class="pause-button assistant-resume" hidden>继续查询本次任务</button>
    <form class="assistant-form"><textarea id="assistant-input" aria-label="你的请求" maxlength="500" rows="2" required placeholder="输入请求，例如：查看上次数据"></textarea><button type="submit" class="pause-button primary-button">发送请求</button><button type="button" class="pause-button assistant-cancel" disabled>取消当前任务</button></form>
  </section>`);
  root.append(panel);
  container.replaceChildren(root);
  const select = panel.querySelector("select"),
    form = panel.querySelector("form"),
    input = panel.querySelector("textarea");
  const messages = panel.querySelector(".assistant-messages");
  const visualSettings = panel.querySelector(".assistant-visual-settings");
  visualSettings.querySelector("input").value = conversation.visualEvents.cooldownMs / 1000;
  visualSettings.querySelector("button").addEventListener("click", () => {
    try {
      conversation.visualEvents.setCooldown(Number(visualSettings.querySelector("input").value) * 1000);
      visualSettings.querySelector("span").textContent = "已保存；下次忽略时生效。";
    } catch (error) { visualSettings.querySelector("span").textContent = error.message; }
  });
  const imageViewer = ImageViewer();
  let autoSpeak = true;
  // Voice and keyboard share this exact entry; no second parser or task API.
  function submitMessage(message, target) {
    if (!message.trim()) return;
    if (voice.active) { voice.releaseRecognition(true); voice.input("idle", "语音输入已停止。"); }
    return conversation.send(message, target);
  }
  const voice = new AssistantVoice({ onTranscript: submitMessage, onChange: renderVoice });
  const detachVoice = conversation.attachVoice(voice, () => autoSpeak);
  function renderVoice() {
    conversation.syncSpeech();
    const labels = { idle: "等待", requesting: "正在请求麦克风权限", listening: "录音中", recognizing: "识别中", recognized: "已识别", error: "失败", unsupported: "不可用" };
    const playback = { generating: "生成语音中", playing: "播报中", completed: "播报完成", error: "播报失败" };
    const failure = ["error", "unsupported"].includes(voice.inputState) ? ` · ${voice.inputMessage.split(/[，。；]/)[0]}` : "";
    panel.querySelector(".assistant-asr-status").textContent = `语音：${labels[voice.inputState]}${failure}${playback[voice.outputState] ? ` · ${playback[voice.outputState]}` : ""}`;
    panel.querySelector(".assistant-asr-detail").textContent = voice.inputMessage;
    panel.querySelector(".assistant-transcript").hidden = !voice.transcript;
    panel.querySelector(".assistant-transcript span").textContent = voice.transcript;
    panel.querySelector(".assistant-tts-status").textContent = `语音播报：${voice.outputMessage}`;
    panel.querySelector(".assistant-voice-start").disabled = !voice.asrAvailable || voice.active;
    panel.querySelector(".assistant-voice-stop").disabled = !voice.active || voice.inputState === "recognizing";
    panel.querySelector(".assistant-speak").disabled = !voice.ttsAvailable || !conversation.currentRequestId || voice.active || conversation.busy;
    panel.querySelector(".assistant-speak-stop").disabled = !voice.utterance;
    select.disabled = voice.active;
    input.disabled = false;
    form.querySelector("button").disabled = false;
    panel.querySelector(".assistant-cancel").disabled = !conversation.currentRequestId && !voice.active;
    panel.querySelector(".assistant-resume").disabled = conversation.busy || voice.active;
  }
  let signature = "";
  const rows = new Map();
  const unsubscribe = conversation.subscribe((state) => {
    // Follow only this history pane, and only when already near its bottom.
    const scroller = messages;
    const followLatest = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    const next = JSON.stringify(state.devices);
    if (next !== signature) {
      signature = next;
      select.replaceChildren(
        new Option("请选择设备，也可在对话中说明", ""),
        ...state.devices.map((d) => new Option(d.name, d.id)),
      );
    }
    select.value = state.context.device || "";
    const phaseLabels = { checking_device: "检查设备…", creating_task: "创建任务…", waiting_device: "等待设备响应…", running: "设备采集中…", inferring: "分析画质…" };
    form.querySelector("button").textContent = state.busy ? (phaseLabels[state.messages.at(-1)?.phase] || "正在处理…") : "发送请求";
    panel.querySelector(".assistant-inventory").textContent = state.inventoryError
      ? "设备列表暂不可用，发送请求时会重新检查连接。"
      : "";
    panel.querySelector(".assistant-resume").hidden = !state.pendingTask || state.busy;
    for (const message of state.messages) {
      let row = rows.get(message);
      if (!row) {
        const el = element(
          '<article class="assistant-message"><div class="assistant-message-heading"></div><p class="assistant-message-text"></p><p class="assistant-task-id" hidden></p><figure class="assistant-image" hidden></figure><div class="assistant-vision" hidden></div><div class="assistant-image-actions" hidden></div><div class="assistant-visual-confirmation" hidden></div><details class="assistant-evidence" hidden><summary>详细信息</summary><div class="assistant-evidence-content"></div></details></article>',
        );
        el.classList.toggle("from-user", message.role === "user");
        row = { el, signature: "" };
        rows.set(message, row);
        messages.append(el);
      }
      const visualEvent = message.visual_event;
      const messageSignature = JSON.stringify(message) + (visualEvent ? `${state.busy}:${state.currentRequestId}` : "");
      if (row.signature === messageSignature) continue;
      row.signature = messageSignature;
      row.el.dataset.status = message.status || "user";
      row.el.querySelector(".assistant-message-heading").textContent =
        message.role === "user"
          ? "你"
          : message.kind === "vision"
            ? "视觉分析 · 公开预训练基线"
          : message.kind === "image"
            ? "本次环境图像"
          : message.kind === "new"
            ? "本次采集任务"
            : message.kind === "existing"
              ? "已有数据查询"
              : "助手";
      row.el.querySelector(".assistant-message-text").textContent = message.message;
      const taskId = row.el.querySelector(".assistant-task-id");
      taskId.hidden = !message.task_id || message.kind === "vision";
      taskId.textContent = message.task_id ? `任务编号：${message.task_id}` : "";
      const picture = row.el.querySelector(".assistant-image");
      picture.replaceChildren();
      picture.hidden = !(message.image && (message.status === "success" || message.inference));
      if (!picture.hidden) {
        const link = document.createElement("button"), img = document.createElement("img"), caption = document.createElement("figcaption");
        link.type = "button";
        link.className = "assistant-image-open";
        link.setAttribute("aria-label", "查看大图");
        img.src = message.image.url;
        img.alt = `${message.device} · ${message.kind === "vision" ? "分析所用" : message.kind === "existing" ? "历史" : "本次"}环境图像`;
        img.width = message.image.width; img.height = message.image.height;
        caption.textContent = `${message.kind === "vision" ? "分析所用图片" : message.kind === "existing" ? "历史图片" : "本次图片"} · ${message.device} · ${dateTime(message.image.capture_time * 1000)} · ${message.image.source} · 点击查看大图`;
        link.addEventListener("click", () => imageViewer.open(message.image.url, caption.textContent.replace(" · 点击查看大图", "")));
        img.addEventListener("error", () => {
          img.hidden = true;
          caption.textContent = "图片不可用或已到保留期限；任务编号与原拍摄时间仍保留。";
        });
        link.append(img); picture.append(link, caption);
      }
      const vision = row.el.querySelector(".assistant-vision"), actions = row.el.querySelector(".assistant-image-actions");
      vision.replaceChildren(); actions.replaceChildren();
      const inference = message.inference;
      vision.hidden = !inference;
      const humanLabels = { usable: "可用（人工确认）", unusable: "不可用（人工确认）", occluded: "遮挡（人工确认）", unknown: "不确定（人工确认）" };
      if (inference) {
        for (const [label, value] of [
          ["模型分数", inference.score == null ? "无法计算有效分数" : `${inference.score.toFixed(2)} / 100（失真分数，越低越好）`],
          ["状态", { accepted: "画质参考 · 需人工确认", unknown: "未知 / 拒识", failed: "推理失败" }[inference.status]],
          ["模型版本", `${inference.model_name} · ${inference.model_version}`],
        ]) { const p = document.createElement("p"); p.textContent = `${label}：${value}`; vision.append(p); }
        for (const feedback of message.feedback || []) {
          const p = document.createElement("p"); p.textContent = `人工纠正：${humanLabels[feedback.corrected_label]} · ${dateTime(feedback.feedback_time * 1000)}（原模型输出保留）`; vision.append(p);
        }
      }
      actions.hidden = !message.image || !["success", "error"].includes(message.status);
      if (!actions.hidden) {
        const analyze = document.createElement("button");
        analyze.type = "button"; analyze.className = "pause-button"; analyze.textContent = "分析这张图片";
        analyze.addEventListener("click", () => submitMessage("分析这张图片", { image: message.image }));
        actions.append(analyze);
        if (inference) {
          const retake = document.createElement("button");
          retake.type = "button"; retake.className = "pause-button"; retake.textContent = "重新拍摄并分析";
          retake.addEventListener("click", () => {
            if (conversation.awaitingVisualEvent?.event_id === visualEvent?.event_id && visualEvent)
              submitMessage("重新拍摄", { visualEventId: visualEvent.event_id });
            else submitMessage("看看当前画面是否可用", { device: message.device, retakeFrom: inference.inference_id });
          });
          const correction = document.createElement("details"), summary = document.createElement("summary");
          summary.textContent = "人工纠正"; correction.append(summary);
          const correctionForm = document.createElement("form"), choice = document.createElement("select"), save = document.createElement("button");
          choice.setAttribute("aria-label", "人工纠正标签");
          choice.append(new Option("请选择你的判断", ""), ...Object.entries(humanLabels).map(([value, label]) => new Option(label, value)));
          choice.required = true;
          save.type = "submit"; save.className = "pause-button"; save.textContent = message.savingFeedback ? "保存中…" : "保存人工纠正";
          save.disabled = !!message.savingFeedback;
          correctionForm.append(choice, save);
          correctionForm.addEventListener("submit", event => { event.preventDefault(); if (choice.value) conversation.correct(message, choice.value); });
          correction.append(correctionForm); actions.append(retake, correction);
          if (message.feedbackError) { const p = document.createElement("p"); p.textContent = message.feedbackError; actions.append(p); }
        }
      }
      const confirmation = row.el.querySelector(".assistant-visual-confirmation");
      confirmation.replaceChildren(); confirmation.hidden = !visualEvent;
      if (visualEvent) {
        const active = visualEvent.status === "awaiting_confirmation" &&
          conversation.awaitingVisualEvent === visualEvent && message.request_id === state.currentRequestId;
        const text = document.createElement("p");
        text.textContent = active ? visualEvent.question : {
          confirmed: "已确认重拍，原图片与推理记录保留。", ignored: "已忽略，本类提示进入冷却。",
          suppressed: "本类提示仍在冷却，本次不再询问。", cancelled: "此询问已取消。",
          superseded: "此询问已被新的请求替代。", recorded: "设备不可用，暂不询问重拍。",
          deferred: "本次暂不询问重拍，可查看详细信息。",
        }[visualEvent.status] || "此询问已结束。";
        confirmation.append(text);
        if (active) {
          for (const [label, reply] of [["重新拍摄", "重新拍摄"], ["忽略", "忽略"]]) {
            const button = document.createElement("button");
            button.type = "button"; button.className = "pause-button"; button.textContent = label;
            button.disabled = state.busy;
            button.addEventListener("click", () => submitMessage(reply, { visualEventId: visualEvent.event_id }));
            confirmation.append(button);
          }
        }
      }
      const evidence = row.el.querySelector(".assistant-evidence-content");
      evidence.replaceChildren();
      for (const [label, value] of [
        ["请求编号", message.request_id],
        ["设备", message.device],
        ["来源", message.source],
        ["图像任务编号", message.kind === "vision" ? message.task_id : null],
        ["图片记录", message.image?.id],
        ["推理编号", inference?.inference_id],
        ["视觉事件编号", visualEvent?.event_id],
        ["事件类型 / 归因", visualEvent ? `${visualEvent.event_type} / ${visualEvent.category}` : null],
        ["事件时间", visualEvent ? dateTime(visualEvent.event_time) : null],
        ["事件图片记录", visualEvent?.image_record_id],
        ["事件图像任务", visualEvent?.image_task_id],
        ["用户选择", visualEvent?.decision],
        ["选择时间", visualEvent?.decision_time ? dateTime(visualEvent.decision_time) : null],
        ["冷却至", visualEvent?.cooldown_until ? dateTime(visualEvent.cooldown_until) : null],
        ["确认后的请求编号", visualEvent?.decision_request_id],
        ["新图像任务编号", visualEvent?.new_task_id],
        ["未询问原因", visualEvent?.reason],
        ["设备问题来源任务", visualEvent?.device_evidence_task_id],
        ["推理时间", inference ? dateTime(inference.inference_time * 1000) : null],
        ["原输出标签（应用画质分段）", inference?.label],
        ["拒识 / 失败原因", inference?.reason],
        ["接受规则", inference ? `失真分数 ≤ ${inference.policy.good_max}：较少；≥ ${inference.policy.poor_min}：较多；中间范围拒识。可调整的应用规则，尚未校准，不是模型置信阈值。` : null],
        [
          "服务器接收时间",
          message.samples?.[0]
            ? `${dateTime(message.samples[0].received_at_ms)}（北京时间）`
            : null,
        ],
      ]) {
        if (value == null) continue;
        const line = document.createElement("p");
        line.textContent = `${label}：${value}`;
        evidence.append(line);
      }
      if (message.samples?.length > 1) {
        const table = DataTable("助手查询记录");
        table.update(message.samples);
        evidence.append(table.root);
      }
      row.el.querySelector(".assistant-evidence").hidden = !evidence.childElementCount;
    }
    if (followLatest) scroller.scrollTop = scroller.scrollHeight;
    renderVoice();
  });
  select.addEventListener("change", () => conversation.chooseDevice(select.value));
  panel.querySelectorAll(".assistant-examples button").forEach((button) =>
    button.addEventListener("click", () => {
      if (voice.active) return;
      input.value = button.dataset.request;
      input.focus();
    }),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    submitMessage(message);
  });
  panel.querySelector(".assistant-voice-start").addEventListener("click", () => voice.start());
  panel.querySelector(".assistant-voice-stop").addEventListener("click", () => voice.stop());
  panel.querySelector(".assistant-auto-speak").addEventListener("change", (event) => {
    autoSpeak = event.target.checked;
    if (!autoSpeak) conversation.stopSpeaking();
  });
  panel.querySelector(".assistant-speak").addEventListener("click", () => conversation.speakCurrent());
  panel.querySelector(".assistant-speak-stop").addEventListener("click", () => conversation.stopSpeaking());
  panel.querySelector(".assistant-cancel").addEventListener("click", () => submitMessage("取消当前任务"));
  panel.querySelector(".assistant-resume").addEventListener("click", () => {
    if (voice.active) return;
    conversation.resume();
  });
  conversation.loadDevices();
  return () => { unsubscribe(); detachVoice(); voice.dispose(); imageViewer.destroy(); };
}
