const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zct-'));
const repo = path.join(tmp, 'repo');
const pc = path.join(repo, 'app', 'pc-dist');
fs.ensureDirSync(pc);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
fs.ensureDirSync(path.join(repo, 'scripts', 'patches'));

// Minimal bundle carrying the anchors the patch targets.
const BUNDLE =
  'x();this._videoCall=async(e=!0,t=null)=>{const n=await this._getFullInfoConversation();' +
  'if(!j.d.isSupport())return;if(j.d.isCalling())return;let a=t;' +
  ';j.d.makeCall(t,e,i,(e=>{q(e)}));' +
  '_sendToNative(e){this.x(),$zcall.sendDataToNative(e)}' +
  '_callMainInit(e){$zcall.initCall(e)}';
fs.writeFileSync(path.join(pc, 'compact-app-pc.abc.js'), BUNDLE, 'utf8');

fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-call-trace.js'), path.join(repo, 'scripts', 'patches', 'patch-call-trace.js'));
fs.symlinkSync(path.join(__dirname, '..', '..', '..', 'node_modules'), path.join(repo, 'node_modules'), 'dir');

const { main } = require(path.join(repo, 'scripts', 'patches', 'patch-call-trace.js'));

(async () => {
  await main();
  const s = fs.readFileSync(path.join(pc, 'compact-app-pc.abc.js'), 'utf8');
  // reach-probes still present
  assert.ok(s.includes('[CALLDIAG] videoCall-click'), 'videoCall-click reach probe');
  assert.ok(s.includes('[CALLDIAG] sendToNative'), 'sendToNative reach probe');
  // payload dumps present with JSON.stringify of the arg
  assert.ok(s.includes('[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e)'), 'sendToNative payload dump');
  assert.ok(s.includes('[CALLDIAG-PAYLOAD] callMainInit "+JSON.stringify(e)'), 'callMainInit payload dump');
  // idempotent
  await main();
  const s2 = fs.readFileSync(path.join(pc, 'compact-app-pc.abc.js'), 'utf8');
  assert.strictEqual(s, s2, 'idempotent');
  assert.strictEqual((s2.match(/\[CALLDIAG-PAYLOAD\] sendToNative/g) || []).length, 1, 'single payload dump');

  // Upgrade path: a tree traced by an OLDER build (reach-only probes, no payload) gains dumps.
  const OLD =
    'this._videoCall=async(e=!0,t=null)=>{X}try{console.error("[CALLDIAG] videoCall-click")}catch(_e){}' +
    '_sendToNative(e){try{console.error("[CALLDIAG] sendToNative")}catch(_e){}$zcall.sendDataToNative(e)}' +
    '_callMainInit(e){try{console.error("[CALLDIAG] callMainInit")}catch(_e){}$zcall.initCall(e)}';
  const old = path.join(pc, 'compact-app-pc.old.js');
  fs.writeFileSync(old, OLD, 'utf8');
  await main();
  const su = fs.readFileSync(old, 'utf8');
  assert.ok(su.includes('[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e)'), 'upgraded sendToNative payload dump');
  assert.ok(su.includes('[CALLDIAG-PAYLOAD] callMainInit "+JSON.stringify(e)'), 'upgraded callMainInit payload dump');
  assert.strictEqual((su.match(/\[CALLDIAG\] sendToNative/g) || []).length, 1, 'no double reach-probe after upgrade');

  fs.removeSync(tmp);
  console.log('OK patch-call-trace');
})().catch((e) => { console.error(e); process.exit(1); });
