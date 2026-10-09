// Execute the extracted production task controller with isolated protocol fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../web/services/captureTask.js'),'utf8').replace(/^import .*;$/mg,'').replace('export function','function');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function dashboard(_socket,fetchHandler=null,storage=new Map(),latestHandler=null) {
  const elements=new Map(),timers=new Map(),listeners=new Map(),requests=[];let clock=0,serial=0;
  function element(id){if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,handlers:new Map(),addEventListener(k,fn){this.handlers.set(k,fn);},removeEventListener(k){this.handlers.delete(k);}});return elements.get(id);}
  const document={hidden:false,addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:k=>listeners.delete(k)};
  const api={async fetchJson(url,options){requests.push(url);const result=url.startsWith('/api/task/latest')?(latestHandler?await latestHandler(url,options):{ok:true,json:async()=>({task:null})}):await fetchHandler(url,options);if(!result.ok){const error=new Error('HTTP');error.status=result.status;throw error;}return result.json();}};
  const context=vm.createContext({document,api,AXES:['acc_x','acc_y','acc_z'],panel:{querySelector:id=>element(id.slice(1))},captureButton:element('capture-button'),sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout(fn,delay){const id=++serial;timers.set(id,{callback:fn,delay,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source+"\nconst dispose=mountCaptureTask(panel,captureButton,api,'ESP32_S3_EYE');",context);
  return {element,timers,requests,latest:{},document,dispose:()=>vm.runInContext('dispose()',context),visibility(hidden){document.hidden=hidden;listeners.get('visibilitychange')();},async timer(delay){const target=clock+delay;while(true){const entry=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;clock=entry[1].at;timers.delete(entry[0]);await entry[1].callback();await settle();}clock=target;}};
}
const taskId='11111111-1111-4111-8111-111111111111';
const reply=value=>({ok:true,json:async()=>value});
test("capture click posts once, polls states, and shows only the associated result", async () => {
  let task = { request_id: taskId, status: "PENDING" };
  let posts = 0;
  const app = dashboard(undefined, (url, options) => {
    if (url === "/api/task/create") {
      posts++;
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {device:"ESP32_S3_EYE",action:"capture_once"});
      return reply(task);
    }
    assert.equal(url, `/api/task/${taskId}`);
    return reply(task);
  });
  const click = app.element("capture-button").handlers.get("click");
  await Promise.all([click(), click()]);
  assert.equal(posts, 1);
  assert.equal(app.element("capture-button").disabled, true);
  task = {...task, status:"RUNNING"};
  await app.timer(1000);
  assert.equal(app.element("task-status").textContent, "正在采集");
  app.latest.acc_x = 1.999;
  task = {...task, status:"SUCCESS",result_sample_id:42,result:{id:42,acc_x:.123,acc_y:.456,acc_z:.789,timestamp:"2026-09-23 12:00:00"}};
  await app.timer(1000);
  assert.match(app.element("task-result").textContent, /采样记录编号：42.*第一轴 0\.123 倍/);
  assert.doesNotMatch(app.element("task-result").textContent, /1\.999/);
  assert.equal(app.element("capture-button").disabled, false);
  const taskReads = app.requests.filter(url => url === `/api/task/${taskId}`).length;
  await app.timer(2000);
  assert.equal(app.requests.filter(url => url === `/api/task/${taskId}`).length, taskReads);
});

test("task polling recovers from network errors and pauses while hidden", async () => {
  let fail = true;
  const storage = new Map([["imu-last-capture", taskId]]);
  const app = dashboard(undefined, () => {
    if (fail) throw new Error("offline");
    return reply({request_id:taskId,status:"FAILED",error:"sensor_error"});
  }, storage);
  await settle();
  assert.equal(app.element("capture-button").disabled, true);
  assert.match(app.element("task-status").textContent, /重试/);
  app.visibility(true);
  const before = app.requests.length;
  await app.timer(5000);
  assert.equal(app.requests.length, before);
  fail = false;
  app.visibility(false);
  await settle();
  assert.equal(app.element("task-status").textContent, "执行失败");
  assert.equal(app.element("task-result").textContent, "传感器读取异常，请检查设备。");
  assert.equal(app.element("capture-button").disabled, false);
});

test("existing task panel displays TIMEOUT and stops polling", async () => {
  const storage = new Map([["imu-last-capture", taskId]]);
  const app = dashboard(undefined, () => reply({request_id:taskId,status:"TIMEOUT",error:"task timeout"}), storage);
  await settle();
  assert.equal(app.element("task-status").textContent, "任务超时");
  assert.equal(app.element("task-result").textContent, "任务超时，未能及时收到设备执行结果。");
  assert.equal(app.element("capture-button").disabled, false);
  const reads = app.requests.filter(url => url === `/api/task/${taskId}`).length;
  await app.timer(5000);
  assert.equal(app.requests.filter(url => url === `/api/task/${taskId}`).length, reads);
});

test("all six protocol task states display Chinese without changing their task IDs", async () => {
  const cases = [
    ["PENDING", "等待设备"], ["SENT", "任务已下发"], ["RUNNING", "正在采集"],
    ["SUCCESS", "采集完成"], ["FAILED", "执行失败"], ["TIMEOUT", "任务超时"],
  ];
  for (const [status, label] of cases) {
    const task = { request_id: taskId, status };
    const storage = new Map([["imu-last-capture", taskId]]);
    const app = dashboard(undefined, () => reply(task), storage);
    await settle();
    assert.equal(app.element("task-status").textContent, label, status);
    assert.doesNotMatch(app.element("task-status").textContent, /[A-Za-z]/);
    assert.equal(app.element("task-request-id").textContent, taskId);
    assert.ok(app.requests.includes(`/api/task/${taskId}`));
    assert.equal(task.status, status, "Display translation must not alter protocol values");
  }
});

test("device and server failure codes display actionable Chinese messages", async () => {
  const cases = [
    ["capture_queue_busy", "设备采集队列繁忙，请稍后重试。"],
    ["capture_timeout", "设备采集超时，请检查传感器连接。"],
    ["sensor_or_clock_error", "传感器读取或设备时间同步异常，请检查设备。"],
    ["invalid_sensor_result", "本次采样结果无效，请检查传感器。"],
    ["upload_unconfirmed", "采样结果上传尚未确认，请检查设备与服务器连接。"],
  ];
  for (const [error, message] of cases) {
    const storage = new Map([["imu-last-capture", taskId]]);
    const app = dashboard(undefined, () => reply({ request_id: taskId, status: "FAILED", error }), storage);
    await settle();
    assert.equal(app.element("task-result").textContent, message, error);
    assert.doesNotMatch(app.element("task-result").textContent, /[A-Za-z]/);
  }
});

test("unknown task states and English errors use Chinese fallbacks", async () => {
  for (const status of ["UNKNOWN_STATE", "toString", "__proto__"]) {
    const storage = new Map([["imu-last-capture", taskId]]);
    const app = dashboard(undefined, () => reply({ request_id: taskId, status, error: "Unexpected backend Error" }), storage);
    await settle();
    assert.equal(app.element("task-status").textContent, "未知状态", status);
    assert.equal(app.element("task-result").textContent, "任务执行异常，请根据任务编号查看服务器记录。");
    assert.doesNotMatch(app.element("task-status").textContent + app.element("task-result").textContent, /[A-Za-z]/);
  }
});

test("physical-button task appears in the existing card with its own sample", async () => {
  let latest = null;
  const task = { request_id: taskId, status: "SUCCESS", result_sample_id: 51,
    result: { id: 51, acc_x: .123, acc_y: -.456, acc_z: .789, timestamp: "2026-09-23 12:00:00" } };
  const app = dashboard(undefined, (url) => {
    assert.equal(url, `/api/task/${taskId}`);
    return reply(task);
  }, new Map(), () => reply({ task: latest }));
  await settle();
  latest = task;
  await app.timer(2000);
  assert.equal(app.element("task-request-id").textContent, taskId);
  assert.equal(app.element("task-status").textContent, "采集完成");
  assert.match(app.element("task-result").textContent, /采样记录编号：51.*第一轴 0\.123 倍/);
  assert.equal(app.element("capture-button").disabled, false);
  assert.ok(!app.requests.includes("/api/task/create"));
});

test("failed creation is not automatically posted again", async () => {
  let posts = 0;
  const app = dashboard(undefined, () => { posts++; throw new Error("response lost"); });
  await app.element("capture-button").handlers.get("click")();
  await app.timer(5000);
  assert.equal(posts, 1);
  assert.match(app.element("task-status").textContent, /未确认/);
  assert.equal(app.element("capture-button").disabled, false);
});

test("missing persisted task releases button and clears persistence", async () => {
  const storage = new Map([["imu-last-capture",taskId]]);
  const app = dashboard(undefined, () => ({ok:false,status:404}), storage);
  await settle();
  assert.equal(storage.has("imu-last-capture"), false);
  assert.equal(app.element("capture-button").disabled, false);
  assert.match(app.element("task-status").textContent, /不存在/);
});


test('unmount cancels polling and late status responses cannot mutate another page',async()=>{
 let resolve;const response=new Promise(r=>resolve=r);
 const app=dashboard(undefined,()=>response,new Map([['imu-last-capture',taskId]]));
 app.dispose();const before=app.element('task-status').textContent;
 resolve(reply({request_id:taskId,status:'SUCCESS'}));await settle();
 assert.equal(app.element('task-status').textContent,before);assert.equal(app.timers.size,0);
});
