const assert = require('assert');
const { applyCallLogPatch } = require('../patch-call-log.js');

// representative bundle slice: the bubble handler (guard + payload) + the message template
const SRC =
  'case"bubble":{if(A.default.call.sync_call_message.ui)return;' +
  'const e={caller:n.role,duration:1e3*n.duration,userId:n.partnerId};n.role?this.cbGen(e):this.cbRecv(e);break}' +
  ';generateCallMsgTemplate(e,t){let a=e.userId,o=t.caller,r=t.duration?Math.floor(t.duration/1e3):0;' +
  'return{content:{action:o?"recommened.calling":"recommened.receivecall",duration:r,' +
  'params:\'{"isEnableCallback":1}\',title:o?"Cuộc gọi đi":"Cuộc gọi đến"},uidFrom:o?"0":a}}';

const r1 = applyCallLogPatch(SRC);
assert.strictEqual(r1.applied, 4, 'all four transforms fire');
assert.ok(r1.src.includes('sync_call_message.ui&&0)return;'), 'guard neutralized');
assert.ok(!r1.src.includes('sync_call_message.ui)return;'), 'original guard gone');
assert.ok(r1.src.includes(',reason:n.reason,calltype:n.calltype,missed:n.missed}'), 'bubble threads reason/calltype/missed');
assert.ok(r1.src.includes('t.missed?"recommened.misscall":t.caller?"recommened.calling":"recommened.receivecall"'), 'action derives from t.missed');
assert.ok(r1.src.includes('params:JSON.stringify({isCaller:t.caller?1:0,calltype:t.calltype||0,reason:t.reason||0,isEnableCallback:1})'), 'params built from t.caller/reason/calltype');

// idempotent
const r2 = applyCallLogPatch(r1.src);
assert.strictEqual(r2.applied, 0, 'idempotent: nothing re-applied');
assert.strictEqual(r2.src, r1.src, 'idempotent: unchanged');

// a bundle with none of the anchors -> 0 applied, unchanged
const none = applyCallLogPatch('var x=1;');
assert.strictEqual(none.applied, 0, 'no anchors -> nothing applied');

// the "s" caller-var form (compact-app-pc) still gets action rewritten var-agnostically
const S2 = 'x=s?"recommened.calling":"recommened.receivecall";params:\'{"isEnableCallback":1}\'';
const r3 = applyCallLogPatch(S2);
assert.ok(r3.src.includes('t.missed?"recommened.misscall":t.caller?"recommened.calling":"recommened.receivecall"'), 'action rewrite is caller-var-agnostic');

console.log('OK patch-call-log');
