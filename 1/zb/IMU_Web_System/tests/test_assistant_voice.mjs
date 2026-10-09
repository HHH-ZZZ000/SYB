import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantVoice } from "../web/services/assistantVoice.js";
import { AssistantSession } from "../web/services/assistantSession.js";

// Browser event doubles: these tests do NOT prove microphone or audible output.
function fixture(options = {}) {
  const transcripts = [], spoken = [], timers = new Map();
  let next = 0, recognizer, cancelCount = 0;
  class Recognition {
    constructor() { recognizer = this; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  class Utterance { constructor(text) { this.text = text; } }
  const synthesis = { getVoices: () => [], speak: (u) => spoken.push(u), cancel: () => cancelCount++ };
  const voice = new AssistantVoice({
    Recognition, synthesis, Utterance, secure: true,
    onTranscript: (text) => transcripts.push(text),
    setTimer: (fn, ms) => { const id = ++next; timers.set(id, {fn, ms}); return id; },
    clearTimer: (id) => timers.delete(id), ...options,
  });
  const result = (text, final = true) => recognizer.onresult({results: [Object.assign([{transcript: text}], {isFinal: final})]});
  const fire = (ms) => {
    const entry = [...timers].find(([, t]) => t.ms === ms);
    assert.ok(entry, `expected timer ${ms}`);
    timers.delete(entry[0]); entry[1].fn();
  };
  return { voice, transcripts, spoken, timers, result, fire,
    get recognizer() { return recognizer; }, get cancels() { return cancelCount; } };
}

test("push-to-talk has bounded listening, interim display, stop, and one final dispatch", () => {
  const f = fixture(); f.voice.start();
  assert.equal(f.voice.inputState, "requesting");
  assert.equal(f.recognizer.continuous, false);
  f.recognizer.onaudiostart();
  assert.equal(f.voice.inputState, "listening");
  f.result("查看上次", false);
  assert.equal(f.voice.transcript, "查看上次");
  assert.deepEqual(f.transcripts, []);
  f.voice.stop(); assert.equal(f.recognizer.stopped, true);
  assert.equal(f.voice.inputState, "recognizing");
  f.result("查看上次数据"); f.recognizer.onend(); f.recognizer.onend();
  assert.deepEqual(f.transcripts, ["查看上次数据"]);
  assert.equal(f.voice.inputState, "recognized");
  assert.equal(f.timers.size, 0);
});

for (const mode of ["empty", "interim", "nomatch"]) {
  test(`silence or unconfirmed ASR (${mode}) never dispatches`, () => {
    const f = fixture(); f.voice.start();
    if (mode === "interim") f.result("重新采集一次", false);
    if (mode === "nomatch") f.recognizer.onnomatch();
    f.recognizer.onend();
    assert.deepEqual(f.transcripts, []);
    assert.match(f.voice.inputMessage, /没有识别到有效语音/);
  });
}
for (const error of ["not-allowed", "service-not-allowed", "audio-capture", "network", "no-speech", "other"]) {
  test(`recognition ${error} keeps text mode available and ignores late results`, () => {
    const f = fixture(); f.voice.start();
    f.recognizer.onerror({error});
    f.result("重新采集一次"); f.recognizer.onend();
    assert.equal(f.voice.inputState, "error");
    assert.equal(f.voice.active, false);
    assert.deepEqual(f.transcripts, []);
    if (error === "not-allowed") assert.match(f.voice.inputMessage, /权限被拒绝/);
  });
}
test("permission startup and ASR result timeouts release microphone and ignore late completion", () => {
  for (const started of [false, true]) {
    const f = fixture(); f.voice.start();
    if (started) { f.recognizer.onaudiostart(); f.voice.stop(); }
    f.fire(started ? 10000 : 15000);
    assert.equal(f.recognizer.aborted, true);
    f.result("重新采集一次"); f.recognizer.onend();
    assert.deepEqual(f.transcripts, []);
    assert.match(f.voice.inputMessage, /超时/);
  }
});
test("30-second recording limit stops once without continuous restart", () => {
  const f = fixture(); f.voice.start(); f.recognizer.onaudiostart(); f.fire(30000);
  assert.equal(f.recognizer.stopped, true);
  assert.equal(f.voice.inputState, "recognizing");
  f.recognizer.onend(); assert.equal(f.voice.active, false);
});
test("unsupported browser or insecure LAN HTTP disables only ASR", () => {
  for (const option of [{Recognition: null}, {secure: false}]) {
    const f = fixture(option); f.voice.start();
    assert.equal(f.voice.inputState, "unsupported");
    assert.equal(f.recognizer, undefined);
    assert.match(f.voice.inputMessage, /文字输入/);
  }
});
test("TTS preserves exact final failure text and reports real browser event states", () => {
  const f = fixture(); const text = "设备无响应，尚未收到本次采集结果。";
  f.voice.speak(text);
  assert.equal(f.voice.outputState, "generating");
  assert.equal(f.spoken[0].text, text);
  assert.ok(!f.spoken[0].text.includes("成功"));
  f.spoken[0].onstart(); assert.equal(f.voice.outputState, "playing");
  f.spoken[0].onend(); assert.equal(f.voice.outputState, "completed");
  assert.equal(f.timers.size, 0);
});
test("TTS failure and startup/playback timeout do not overwrite task text", () => {
  for (const mode of ["error", "startup", "playback"]) {
    const f = fixture(); const result = {message: "设备执行失败，未取得本次有效结果。", status: "error"};
    f.voice.speak(result.message);
    if (mode === "error") f.spoken[0].onerror();
    if (mode === "startup") f.fire(15000);
    if (mode === "playback") { f.spoken[0].onstart(); f.fire(180000); }
    assert.equal(f.voice.outputState, "error");
    assert.equal(result.status, "error");
    assert.equal(result.message, f.spoken[0].text);
    f.spoken[0].onend(); assert.equal(f.voice.outputState, "error");
  }
});
test("new recording cancels speech; leaving page aborts capture and late callbacks", () => {
  const f = fixture(); f.voice.speak("已有数据"); f.voice.start();
  assert.equal(f.cancels, 1);
  f.voice.dispose(); f.result("重新采集一次"); f.recognizer.onend();
  assert.equal(f.recognizer.aborted, true);
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.timers.size, 0);
});
test("missing TTS and synchronous engine failures are handled", () => {
  const absent = fixture({synthesis: null}); absent.voice.speak("数据");
  assert.equal(absent.voice.outputState, "unsupported");
  const broken = fixture({Recognition: class { start() { throw new Error("fail"); } abort() {} }});
  broken.voice.start(); assert.equal(broken.voice.inputState, "error");
  const speech = fixture({synthesis: { getVoices() { throw new Error("fail"); }, cancel() {} }});
  speech.voice.speak("设备无响应"); assert.equal(speech.voice.outputState, "error");
});
test("text entry still uses AssistantSession after ASR failure; TTS does not change its result", async () => {
  const f = fixture(); f.voice.start(); f.recognizer.onerror({error: "not-allowed"});
  let submitted;
  const session = new AssistantSession({fetchJson: async (_path, options) => {
    submitted = JSON.parse(options.body).message;
    return {status: "clarify", message: "请选择设备。", context: {}, devices: []};
  }}, null);
  await session.send("查看上次数据");
  f.voice.speak(session.messages.at(-1).message); f.spoken[0].onerror();
  assert.equal(submitted, "查看上次数据");
  assert.equal(session.messages.at(-1).message, "请选择设备。");
  assert.equal(session.busy, false);
});
