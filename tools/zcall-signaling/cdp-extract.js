'use strict';
// CDP client: pull the zpw secretKey (breakpoint on getSecretKey), the voicecall-host cookies,
// and one real requestcall sample out of the running Linux Zalo. Live parts need Zalo launched
// with --remote-debugging-port. (GO verdict §5.3; own account/own machine only.)
const zpw = require('./zpw.js');

function cookieHeader(cookies) {
  return (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
}

// Locate the `return le` inside `getSecretKey(){return le...` as 0-based {line,column}.
function findGetSecretKeyReturn(src) {
  const idx = src.indexOf('getSecretKey(){return ');
  if (idx < 0) return null;
  const retIdx = src.indexOf('return ', idx);
  const before = src.slice(0, retIdx);
  const line = before.split('\n').length - 1;
  const column = retIdx - (before.lastIndexOf('\n') + 1);
  return { line, column };
}

// --- live CDP (integration; not unit-tested — validated by a real run) ---
async function extract({ port = 9222, bundleUrlRe = /default-login-main-startup.*\.js$/, voicecallHost = 'https://voicecall-wpa.chat.zalo.me/' } = {}) {
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('cdp-extract: no debuggable page target — launch Zalo with --remote-debugging-port=' + port + ' --remote-allow-origins=*');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp-extract: WS connect failed')); });

  let id = 0; const pending = new Map(); const scripts = new Map(); let paused = null;
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Debugger.scriptParsed' && bundleUrlRe.test(m.params.url || '')) scripts.set(m.params.scriptId, m.params.url);
    if (m.method === 'Debugger.paused') paused = m.params;
    events.push(m);
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });

  await send('Debugger.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');

  // 1. secretKey via a breakpoint on getSecretKey.
  //    Find the bundle script, get its source, locate `return le`, set a breakpoint, wait for a hit.
  await new Promise((r) => setTimeout(r, 500)); // let scriptParsed events arrive
  let secretKey = null;
  for (const [scriptId] of scripts) {
    const { result } = await send('Debugger.getScriptSource', { scriptId });
    const loc = findGetSecretKeyReturn(result.scriptSource || '');
    if (!loc) continue;
    await send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: loc.line, columnNumber: loc.column } });
    break;
  }
  console.error('[cdp-extract] breakpoint armed on getSecretKey — the app calls it constantly; waiting…');
  for (let i = 0; i < 200 && !paused; i++) await new Promise((r) => setTimeout(r, 100));
  if (!paused) throw new Error('cdp-extract: getSecretKey breakpoint never hit');
  const frame = paused.callFrames[0];
  const evalRes = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: 'le' });
  secretKey = evalRes.result && evalRes.result.value;
  await send('Debugger.resume');
  await send('Debugger.disable');
  if (!secretKey) throw new Error('cdp-extract: could not read secretKey (le) from getSecretKey frame');

  // 2. cookies for the voicecall host.
  const { result: ck } = await send('Network.getCookies', { urls: [voicecallHost] });
  const cookies = cookieHeader(ck.cookies);

  // 3. capture one real requestcall (operator clicks call once).
  console.error('[cdp-extract] now place ONE real call in Zalo to your own phone (captures the request shape)…');
  let sampleUrl = null;
  for (let i = 0; i < 600 && !sampleUrl; i++) {
    const e = events.find((x) => x.method === 'Network.requestWillBeSent' && /voicecall\/requestcall/.test(x.params.request.url));
    if (e) sampleUrl = e.params.request.url;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!sampleUrl) throw new Error('cdp-extract: no requestcall observed — did you place a call?');
  const paramsCipher = new URL(sampleUrl).searchParams.get('params');
  const sampleParamsPlain = JSON.parse(zpw.decodeToString(paramsCipher, secretKey));

  ws.close();
  return { secretKey, cookieHeader: cookies, sampleUrl, sampleParamsPlain };
}

module.exports = { cookieHeader, findGetSecretKeyReturn, extract };
