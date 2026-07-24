'use strict';
// Live signaling via CDP: reach the app's own webpack module registry and invoke any VoiceCall
// API method (requestCall, sendRequestCall, sendEndCall, …) — reusing the app's auth, zpw signing
// and zpw decode. Needs Zalo launched with --remote-debugging-port. Own account / own phone only.
//
// Why invoke instead of capture/rebuild: on Linux these JS methods are only triggered by a
// native-engine signal (native is stubbed), so they can't be captured; and rebuilding standalone
// must reproduce the per-request common-params signing. Invoking the app's own function sidesteps
// both. (GO verdict §1–§3.)

// Pure: the JS expression evaluated in the page. Self-locates the module/object exposing
// `[method]` (robust to minified module-id changes) via the webpack-4 `webpackJsonp` require grab,
// then calls api[method](...args).
function buildVoiceCallExpr({ method, args }) {
  const m = JSON.stringify(String(method));
  const a = JSON.stringify(args || []);
  return '(async()=>{try{' +
    'var J=window.webpackJsonp; if(!J||typeof J.push!=="function") return JSON.stringify({err:"no-webpackJsonp"});' +
    'var BID=987654321; if(!window.__wreq){J.push([[BID],{[BID]:function(m,e,r){window.__wreq=r;}},[[BID]]]);}' +
    'var req=window.__wreq; if(!req||!req.c) return JSON.stringify({err:"no-require-cache"});' +
    'var M=' + m + '; var api=null; var ids=Object.keys(req.c);' +
    'for(var i=0;i<ids.length;i++){var ex;try{ex=req.c[ids[i]]&&req.c[ids[i]].exports;}catch(_){continue;} if(!ex)continue;' +
    'if(typeof ex[M]==="function"){api=ex;break;} if(ex.default&&typeof ex.default[M]==="function"){api=ex.default;break;}}' +
    'if(!api) return JSON.stringify({err:"no-"+M+"-module"});' +
    'var args=' + a + ';' +
    'var resp=await api[M].apply(api, args);' +
    'return JSON.stringify(resp===undefined?{ok:true}:resp);' +
    '}catch(e){var em;try{em=(e&&e.message)?e.message:(e&&typeof e==="object"?JSON.stringify(e):String(e));}catch(_){em=String(e);}return JSON.stringify({err:em});}})()';
}

// Back-compat wrapper for the step-1 requestCall path.
function buildInvokeExpr({ calleeId, callId, type }) {
  return buildVoiceCallExpr({ method: 'requestCall', args: [String(calleeId), callId, '[]', Number(type)] });
}

// Live: evaluate a method invocation in the index.html page target, return the parsed result.
async function invokeVoiceCall({ port = 9222, method, args } = {}) {
  if (!method) throw new Error('cdp-invoke: method required');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('index.html')) || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('cdp-invoke: no page target — launch Zalo with --remote-debugging-port=' + port + ' (ZALO_REMOTE_DEBUG=1)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp-invoke: WS connect failed')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (cmd, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: cmd, params: params || {} })); });
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: buildVoiceCallExpr({ method, args }), returnByValue: true, awaitPromise: true });
  ws.close();
  if (r.result && r.result.exceptionDetails) throw new Error('cdp-invoke: eval exception ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  const val = r.result && r.result.result && r.result.result.value;
  const obj = JSON.parse(val);
  if (obj.err) throw new Error('cdp-invoke: ' + obj.err + (obj.keys ? ' keys=' + JSON.stringify(obj.keys) : ''));
  return obj;
}

async function invokeRequestCall({ port = 9222, calleeId, callId, type = 1 } = {}) {
  if (!calleeId) throw new Error('cdp-invoke: calleeId required');
  return invokeVoiceCall({ port, method: 'requestCall', args: [String(calleeId), callId, '[]', Number(type)] });
}

module.exports = { buildVoiceCallExpr, buildInvokeExpr, invokeVoiceCall, invokeRequestCall };
