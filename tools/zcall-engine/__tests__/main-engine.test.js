const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'main-engine.js');
const { createMainEngine } = require(MOD);

class FakeSession {
  constructor(o){ this.o=o; this._h={}; this.sock={address:()=>({port:55555})}; }
  on(ev,cb){ this._h[ev]=cb; }
  async open(){ return { results:[{host:'10.0.0.1',recv:3,rtt:20,flowToken:Buffer.alloc(4,1)}], host:'10.0.0.1', port:4200, flowToken:Buffer.alloc(4,1) }; }
  send(){} close(){ this.closed=true; }
}
class FakeAudio { start(cb){ this.started=true; this._cb=cb; } play(){} stop(){ this.stopped=true; } }

const CONFIG = { sessId:'A'.repeat(154), servers:[{rtpaddr:'10.0.0.1:4200'}], rtpIP:'10.0.0.1:4200', fromId:111, toId:222, changeZRTP:{enable:0} };
const out = [];
const eng = createMainEngine({
  sendToRender: (m)=>out.push(m),
  MediaSession: FakeSession, ZAudio: FakeAudio,
  os: { networkInterfaces: ()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
  randomCallId: ()=>4242,
});

(async () => {
  eng.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{id:'6664'}], type:1 } });
  await new Promise(r=>setTimeout(r,10));
  assert.strictEqual(out[0].type, 'sendSignal', 'emit sendSignal');
  assert.strictEqual(out[0].command, 401, '401 requestcall');
  assert.strictEqual(out[0].data.calleeId, '6664', '401 calleeId');

  eng.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  const s416 = out.find(m=>m.command===416);
  assert.ok(s416, '416 emitted after config');
  assert.strictEqual(s416.data.rtpAddress, '10.0.0.1:4200', '416 selected relay');
  assert.ok(s416.data.codec.includes('opus/16000/1'), '416 opus codec');
  const ext = JSON.parse(s416.data.extendData);
  assert.ok(ext.serverResult.length>=1 && ext.serverAddr.length===1 && ext.srtpMode===1, '416 extendData');

  eng.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:4242 } } });
  await new Promise(r=>setTimeout(r,10));
  assert.ok(out.some(m=>m.command===408), '408 answerack after answer');

  eng.handleSendToNative({ type:'control', data:{ act:'end_call', data:{ callId:4242 } } });

  cp.execFileSync(process.execPath, ['--check', MOD]);
  console.log('OK main-engine');
})().catch(e=>{ console.error(e); process.exit(1); });
