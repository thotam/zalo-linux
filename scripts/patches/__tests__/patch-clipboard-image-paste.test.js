const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const { patchFile } = require('../patch-clipboard-image-paste.js');

// Minimal stub of the paste-image handler `W` plus the locals it closes over
// (dt.c, the props object `e` with uploadPhoto/currentUserId, and the macOS
// $zscreencap detour). Built with plain concatenation so the `(t,n="")` default
// and the `$zscreencap.getClipboard(e.currentUserId)` anchor are literal.
function stub() {
  return (
    'var dt={c:function(f){return typeof f==="function"}};' +
    'var e={uploadPhoto:function(){},currentUserId:"u1"};' +
    'var G=!1,w=!1,L="x",V=function(){},$zscreencap={getClipboard:function(){return Promise.resolve(null)}};' +
    'var W=(t,n="")=>{G||(G=!0,$zscreencap.getClipboard(e.currentUserId).then((a=>{if(!a)return;V(a,e)})))};' +
    'module.exports={W:W};'
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-paste-'));

// 1. patches + injects the native path, keeps the original screencap tail
const f = path.join(tmp, 'bundle.js');
fs.writeFileSync(f, stub());
let r = patchFile(f);
assert.strictEqual(r.patched, true, 'should patch');
assert.strictEqual(r.hasAnchor, true, 'anchor seen');
let c = fs.readFileSync(f, 'utf8');
assert(c.includes('/*__znative_clip_paste__*/'), 'marker present');
assert(c.includes('.getClipboardImage'), 'reads native clipboard image');
assert(c.includes('new File([new Uint8Array(_zb)]'), 'builds a File from native bytes');
assert(c.includes('e.uploadPhoto([_zf],e.currentUserId)'), 'uploads the native image');
assert(c.includes('e.uploadPhoto(t,e.currentUserId)'), 'getAsFile blob fallback kept');
assert(c.includes('$zscreencap.getClipboard(e.currentUserId)'), 'original macOS tail preserved');
// the native path must return before the screencap detour
assert(c.indexOf('.getClipboardImage') < c.indexOf('$zscreencap.getClipboard'), 'native runs before screencap');
// patched bundle still parses
execFileSync('node', ['--check', f]);

// 2. idempotent
r = patchFile(f);
assert.strictEqual(r.already, true, 'second run already');
assert.strictEqual(fs.readFileSync(f, 'utf8'), c, 'no double-inject');

// 3. fail-loud on anchor drift (two handlers)
const dup = path.join(tmp, 'dup.js');
fs.writeFileSync(dup, stub() + stub());
assert.throws(() => patchFile(dup), /anchor/, 'duplicate anchor should throw');

// 4. non-handler bundle -> skip (not an error)
const other = path.join(tmp, 'other.js');
fs.writeFileSync(other, 'console.log("no paste handler here")');
r = patchFile(other);
assert.strictEqual(r.hasAnchor, false, 'no anchor');
assert.strictEqual(r.patched, false, 'skipped, not patched');

fs.removeSync(tmp);
console.log('OK patch-clipboard-image-paste');
