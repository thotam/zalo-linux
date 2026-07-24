const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// DIAGNOSTIC (Linux call gap #4 — signaling verification). The native call media engine
// `zcall.node` is a macOS x86_64 / ABI-57 binary; on Linux binding.js returns
// `{error:'not support'}`, so `ZMacCall.MainApp()` throws and the ENTIRE call subsystem
// (including the voicecall-wpa SIGNALING path: requestcall/ringring/answer) fails to
// initialize — clicking the call button does nothing.
//
// This patch replaces binding.js's non-win/non-darwin branch with a pure-JS STUB whose
// `MainApp()` returns a no-op instance (a Proxy answering any method). That lets the call
// subsystem INITIALIZE so we can observe whether signaling fires (does the callee's phone
// ring?) — isolating "signaling portable, only media missing" from "whole chain dead".
// Media is NON-FUNCTIONAL: no audio/video. Not a shipping fix.
// Idempotent; fail-loud if the anchor is missing.
// ---------------------------------------------------------------------------

const BINDING = path.join(__dirname, '..', '..', 'app', 'native', 'nativelibs', 'zcall', 'binding.js');

const ANCHOR = "return {error: 'not support'};";
const MARKER = '/*linux-zcall-stub*/';
const STUB =
  '/*linux-zcall-stub*/{' +
  'var _noop=function(){};' +
  'var _inst=new Proxy({},{get:function(_t,p){' +
  "if(p==='test')return function(x){return x};" +
  "if(p==='getEventMessage')return function(){return null};" +
  "if(p==='getListDevices')return function(){return '[]'};" +
  "if(p==='getCallInfo'||p==='getExtendData'||p==='getActiveAudioCodecs'||p==='getJsonStats406')return function(){return '{}'};" +
  "if(p==='getVideoFrame'||p==='getVideoFrameLocal')return function(){return null};" +
  'return _noop;}});' +
  'return {MainApp:function(){return _inst}};' +
  '}';

async function main() {
  if (!fs.existsSync(BINDING)) {
    throw new Error(`patch-zcall-linux-stub: ${logger.formatPath(BINDING)} not found (run extract first)`);
  }
  let s = fs.readFileSync(BINDING, 'utf8');

  if (s.includes(MARKER)) {
    logger.dim('zcall-linux-stub: already applied');
    return;
  }
  if (!s.includes(ANCHOR)) {
    throw new Error('patch-zcall-linux-stub: `return {error: \'not support\'};` anchor not found in binding.js — layout changed.');
  }
  s = s.replace(ANCHOR, STUB);
  fs.writeFileSync(BINDING, s, 'utf8');

  if (!s.includes(MARKER)) throw new Error('patch-zcall-linux-stub: stub not applied');
  logger.success('zcall-linux-stub: binding.js Linux branch → no-op MainApp() stub (media non-functional; signaling can init)');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main };
