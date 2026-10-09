// Browser audio only. This adapter never parses intents or calls device APIs.
const ASR_ERRORS = {
  "not-allowed": "麦克风权限被拒绝，请允许此网站使用麦克风，或继续文字输入。",
  "service-not-allowed": "浏览器不允许使用语音识别服务，请继续文字输入。",
  "audio-capture": "无法使用麦克风，请检查连接、系统权限或是否被其他程序占用。",
  "no-speech": "没有识别到有效语音，请重新说话。未执行任务。",
  network: "语音识别服务连接失败，请检查网络或继续文字输入。未执行任务。",
  aborted: "语音识别已停止，未执行任务。",
  "language-not-supported": "当前识别服务不支持中文，请继续文字输入。",
};

export class AssistantVoice {
  constructor({
    Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
    synthesis = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    secure = globalThis.isSecureContext === true,
    onTranscript = () => {}, onChange = () => {},
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
  } = {}) {
    Object.assign(this, { Recognition, synthesis, Utterance, onTranscript, onChange, setTimer, clearTimer });
    this.asrAvailable = secure && typeof Recognition === "function";
    this.ttsAvailable = Boolean(synthesis && typeof Utterance === "function");
    this.inputState = this.asrAvailable ? "idle" : "unsupported";
    this.inputMessage = !secure
      ? "此连接不支持麦克风，请联系管理员启用安全访问。文字输入仍可用。"
      : this.asrAvailable ? "待开始：点击后允许麦克风，并说出请求。"
        : "此浏览器未提供语音识别，请使用支持语音识别的浏览器，或继续文字输入。";
    this.outputState = this.ttsAvailable ? "idle" : "unsupported";
    this.outputMessage = this.ttsAvailable ? "等待任务回答。" : "此浏览器不支持语音播报，文字结果仍可用。";
    this.transcript = "";
    this.recognition = null;
    this.utterance = null;
    this.disposed = false;
  }
  get active() {
    return ["requesting", "listening", "recognizing"].includes(this.inputState);
  }
  input(state, message) {
    this.inputState = state;
    this.inputMessage = message;
    this.onChange(this);
  }
  output(state, message) {
    this.outputState = state;
    this.outputMessage = message;
    this.onChange(this);
  }
  asrTimer(callback, ms) {
    this.clearTimer(this.inputTimer);
    this.inputTimer = this.setTimer(callback, ms);
  }
  releaseRecognition(abort = false) {
    this.clearTimer(this.inputTimer);
    const recognition = this.recognition;
    this.recognition = null; // Late callbacks cannot dispatch an old request.
    if (abort && recognition) {
      try { recognition.abort(); } catch { /* Already stopped by the browser. */ }
    }
  }
  failRecognition(message) {
    this.releaseRecognition(true);
    this.input("error", message);
  }
  start() {
    if (this.disposed || !this.asrAvailable || this.active) return;
    this.stopSpeaking(); // Prevent the assistant's own voice entering the microphone.
    this.transcript = "";
    this.input("requesting", "正在请求麦克风，请允许浏览器使用麦克风。尚未确认开始录音。");
    try {
      const recognition = new this.Recognition();
      this.recognition = recognition;
      recognition.lang = "zh-CN";
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let finalText = "";
      const current = () => !this.disposed && this.recognition === recognition;
      recognition.onaudiostart = () => {
        if (!current() || this.inputState !== "requesting") return;
        this.input("listening", "正在录音，请说话；说完点击“结束说话”。最长 30 秒，不持续监听。");
        this.asrTimer(() => this.stop(), 30000);
      };
      recognition.onaudioend = () => {
        if (!current()) return;
        this.input("recognizing", "录音已停止，正在识别…");
        this.asrTimer(() => this.failRecognition("语音识别超时，未执行任务。请重试或使用文字输入。"), 10000);
      };
      recognition.onresult = (event) => {
        if (!current()) return;
        // Interim text is display-only. Never submit a partial or fabricated command.
        const results = Array.from(event.results);
        finalText = results.filter((r) => r.isFinal).map((r) => r[0]?.transcript || "").join("").trim();
        this.transcript = results.map((r) => r[0]?.transcript || "").join("").trim();
        this.onChange(this);
      };
      recognition.onnomatch = () => {
        if (current()) this.failRecognition(ASR_ERRORS["no-speech"]);
      };
      recognition.onerror = (event) => {
        if (current()) this.failRecognition(ASR_ERRORS[event.error] || "语音识别失败，未执行任务。请重试或使用文字输入。");
      };
      recognition.onend = () => {
        if (!current()) return;
        this.releaseRecognition();
        if (!finalText) return this.input("error", ASR_ERRORS["no-speech"]);
        if (finalText.length > 500) return this.input("error", "识别文字超过 500 字，请缩短请求。未执行任务。");
        this.transcript = finalText;
        this.input("recognized", "识别成功，已交给现有助手处理。");
        this.onTranscript(finalText);
      };
      this.asrTimer(() => this.failRecognition("麦克风或识别服务启动超时，未执行任务。请检查权限后重试。"), 15000);
      recognition.start();
    } catch (error) {
      this.failRecognition(error.name === "NotAllowedError" ? ASR_ERRORS["not-allowed"] : "无法启动语音识别，请继续文字输入。");
    }
  }
  stop() {
    if (!this.recognition || this.inputState === "recognizing") return;
    this.input("recognizing", "正在停止录音并识别…");
    this.asrTimer(() => this.failRecognition("语音识别超时，未执行任务。请重试或使用文字输入。"), 10000);
    try { this.recognition.stop(); }
    catch { this.failRecognition("停止录音失败，已取消本次识别。未执行任务。"); }
  }
  speak(text, requestId = null, isCurrentRequest = () => true) {
    if (this.disposed || !this.ttsAvailable || this.active || !text?.trim() || !isCurrentRequest()) return;
    this.stopSpeaking();
    this.utteranceRequestId = requestId;
    this.output("generating", "正在生成语音…");
    try {
      const utterance = new this.Utterance(text); // Exactly the assistant's final text.
      this.utterance = utterance;
      utterance.lang = "zh-CN";
      const voices = this.synthesis.getVoices();
      const voice = voices.find((v) => /^zh[-_]CN$/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang));
      if (voice) utterance.voice = voice;
      const current = () => !this.disposed && this.utterance === utterance && isCurrentRequest();
      const failed = (message) => {
        if (!current()) return;
        this.stopSpeaking();
        this.output("error", message);
      };
      utterance.onstart = () => {
        if (!current()) return;
        this.clearTimer(this.outputTimer);
        this.output("playing", "正在播放回答…");
        this.outputTimer = this.setTimer(() => failed("语音播放超时，文字结果仍然有效。"), 180000);
      };
      utterance.onend = () => {
        if (!current()) return;
        this.clearTimer(this.outputTimer);
        this.utterance = null;
        this.utteranceRequestId = null;
        this.output("completed", "播放完成（浏览器已报告结束）。");
      };
      utterance.onerror = () => failed("语音播放失败。文字结果仍然有效，可点击“播报最新回答”重试。");
      this.outputTimer = this.setTimer(() => failed("语音生成或播放启动超时。文字结果仍然有效，可点击“播报最新回答”重试。"), 15000);
      this.synthesis.speak(utterance);
      this.onChange(this);
    } catch {
      this.stopSpeaking();
      this.output("error", "语音生成失败，文字结果仍然有效。");
    }
  }
  stopSpeaking() {
    this.clearTimer(this.outputTimer);
    if (!this.utterance) return;
    this.utterance = null;
    this.utteranceRequestId = null;
    try { this.synthesis.cancel(); } catch { /* No task state depends on TTS. */ }
    this.output("idle", "播报已停止，文字结果仍可查看。");
  }
  dispose() {
    this.disposed = true;
    this.onChange = () => {};
    this.onTranscript = () => {};
    this.releaseRecognition(true);
    this.stopSpeaking();
  }
}
