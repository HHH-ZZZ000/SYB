import assert from 'node:assert/strict';
import test from 'node:test';
import {TelemetryStore} from '../web/services/telemetry.js';
import {toDevice,mergeSamples,windowSamples} from '../web/models/Device.js';
import {chartOption} from '../web/components/DataChart.js';
import {validatePreferences,defaults} from '../web/services/preferences.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const base=Date.parse('2026-09-26T12:00:00+08:00');
const row=(id,offset=0,device='ESP32_S3_EYE')=>({id,device,received_at_ms:base+offset,acc_x:.1,acc_y:-.2,acc_z:.98});
function fixture(WebSocket){
  let clock=0,serial=0;const timers=new Map(),intervals=new Map(),listeners=new Map(),requests=[];
  const document={hidden:false,addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:k=>listeners.delete(k)};
  const env={document,location:{protocol:'http:',host:'isolated.invalid'},WebSocket,performance:{now:()=>clock},
    setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id),
    setInterval(fn){const id=++serial;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id)};
  const latest={...row(1),server_time_ms:base,total_samples:1,camera:{status:'offline'}};
  const api={abort(){},async status(id){requests.push(['status',id]);return {...latest,device:id};},async devices(){return {devices:[latest]};},async history(id,cursor){requests.push(['history',id,cursor]);return {samples:[{...row(1),device:id}],has_more:false};}};
  const store=new TelemetryStore(api,{...defaults},env);
  return {store,api,latest,requests,env,timers,intervals,
    async advance(ms){const target=clock+ms;while(true){const entry=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;clock=entry[1].at;timers.delete(entry[0]);await entry[1].fn();await settle();}clock=target;intervals.forEach(fn=>fn());},
    visibility(hidden){document.hidden=hidden;listeners.get('visibilitychange')();}};
}
class Socket {close(){this.onclose?.();}}
test('Device model preserves missing readings and separates unknown/offline/camera freshness',()=>{
  const empty=toDevice({},base);assert.deepEqual(empty.acceleration,{x:null,y:null,z:null});assert.equal(empty.sampleCount,null);
  const raw={...row(1),total_samples:91713,camera:{status:'online',last_frame_at_ms:base}};
  assert.equal(toDevice(raw,base+10000).status,'online');assert.equal(toDevice(raw,base+10001).status,'offline');
  assert.equal(toDevice(raw,base+5001).cameraStatus,'unknown');assert.equal(toDevice(raw,base,true).status,'unknown');
});
test('camera model separates device loss, on-demand, real stream and capture errors',()=>{
  const raw={...row(1),camera:{status:'offline',mode:'on_demand',preview_enabled:false}};
  assert.equal(toDevice(raw,base).cameraStatus,'on_demand');
  assert.equal(toDevice(raw,base+10001).cameraStatus,'device_offline');
  assert.equal(toDevice(raw,base,true).cameraStatus,'unknown');
  for(const mode of ['camera_unavailable','capture_failed'])
    assert.equal(toDevice({...raw,camera:{mode}},base).cameraStatus,mode);
  assert.equal(toDevice({...raw,camera:{status:'online',mode:'streaming',last_frame_at_ms:base}},base).cameraStatus,'streaming');
});
test('samples deduplicate, sort, reject invalid points and bound memory',()=>{
  const records=mergeSamples([row(3,30),row(1,10)],[row(2,20),row(3,30),{...row(4),acc_x:null}],2);
  assert.deepEqual(records.map(s=>s.id),[2,3]);
});
test('20 second window is inclusive and never fills missing samples',()=>{
  const rows=[row(1,-20001),row(2,-20000),row(3,-10000),row(4,0),row(5,1)];
  assert.deepEqual(windowSamples(rows,base).map(s=>s.id),[2,3,4]);
  assert.equal(windowSamples(rows,base+21000).length,0);
});
test('ECharts draws selected axes and breaks lines across acquisition gaps',()=>{
  const option=chartOption([row(1,-2000),row(2,0)],base,20,[true,false,true]);
  assert.equal(option.xAxis.min,base-20000);assert.equal(option.xAxis.max,base);
  assert.equal(option.series[1].data.length,0);assert.equal(option.series[0].data[1][1],null);
  assert.deepEqual(option.series[2].data.at(-1),[base,.98]);
});
test('no WebSocket still polls status and incremental history',async()=>{
  const f=fixture();f.store.start();await settle();
  assert.ok(f.requests.some(r=>r[0]==='status'));assert.equal(f.store.snapshot().device.sampleCount,1);
  await f.advance(500);assert.ok(f.requests.some(r=>r[0]==='history'&&r[2]===1));f.store.stop();assert.equal(f.timers.size,0);
});
test('constructor failure retries and disconnect resumes polling',async()=>{
  let attempts=0,socket;
  const f=fixture(class{constructor(){if(++attempts<3)throw Error('blocked');return socket=new Socket();}});
  f.store.start();await settle();await f.advance(3000);assert.equal(attempts,3);
  socket.onmessage({data:JSON.stringify({type:'snapshot',latest:f.latest})});await settle();assert.equal(f.store.socketReady,true);
  socket.close();await settle();assert.equal(f.store.socketReady,false);assert.ok(f.timers.size);f.store.stop();
});
test('hidden tab cancels requests, retries and socket; visible tab resynchronizes',async()=>{
  const f=fixture();f.store.start();await settle();f.visibility(true);assert.equal(f.timers.size,0);
  const reads=f.requests.length;await f.advance(10000);assert.equal(f.requests.length,reads);
  f.visibility(false);await settle();assert.ok(f.requests.length>reads);f.store.stop();
});
test('older status response cannot overwrite newer push, but camera can update',()=>{
  const f=fixture();f.store.acceptLatest({...row(2,200),total_samples:2});
  f.store.acceptLatest({...row(1),total_samples:1,camera:{status:'online',last_frame_at_ms:base}});
  assert.equal(f.store.raw.get('ESP32_S3_EYE').id,2);assert.equal(f.store.raw.get('ESP32_S3_EYE').total_samples,2);
  assert.equal(f.store.raw.get('ESP32_S3_EYE').camera.status,'online');
});
test('device switch ignores late history from the previous device',async()=>{
  const f=fixture();let resolve;
  f.api.history=id=>id==='ESP32_S3_EYE'?new Promise(r=>resolve=r):Promise.resolve({samples:[row(9,0,id)],has_more:false});
  f.store.start();await settle();f.store.select('SECOND');await settle();
  resolve({samples:[row(100)],has_more:false});await settle();
  assert.ok(f.store.samples.every(r=>r.device==='SECOND'));assert.equal(f.store.selected,'SECOND');f.store.stop();
});
test('history failure is surfaced and a later refresh recovers',async()=>{
  const f=fixture();f.api.history=async()=>{throw Error('down');};f.store.start();await settle();assert.equal(f.store.historyError,true);
  f.api.history=async()=>({samples:[row(1)],has_more:false});assert.equal(await f.store.refresh(),true);assert.equal(f.store.historyError,false);f.store.stop();
});
test('long reconnect gap requests bounded recent history instead of fabricating points',async()=>{
  const f=fixture();let calls=0;f.api.history=async()=>++calls===1?{samples:[row(1)],has_more:true}:{samples:[row(9)],has_more:false};
  f.store.start();await settle();assert.equal(calls,2);assert.equal(f.store.cursor,9);assert.equal(f.store.samples.at(-1).id,9);f.store.stop();
});
test('preferences reject invalid refresh rates and empty user names',()=>{
  assert.equal(validatePreferences({...defaults,refreshMs:'1000'}).refreshMs,1000);
  assert.throws(()=>validatePreferences({...defaults,refreshMs:1}));assert.throws(()=>validatePreferences({...defaults,displayName:' '}));
});
test('manual refresh reports inventory failure instead of claiming full success',async()=>{
  const f=fixture();f.api.devices=async()=>{throw Error('inventory unavailable');};
  f.store.start();await settle();assert.equal(await f.store.refresh(),false);
  assert.equal(f.store.snapshot().inventoryError,true);f.store.stop();
});
