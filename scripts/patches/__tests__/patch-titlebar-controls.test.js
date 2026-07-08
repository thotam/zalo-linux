const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { patchFile } = require('../patch-titlebar-controls.js');
const template = fs.readFileSync(path.join(__dirname, '..', 'data', 'titlebar-controls-win32.txt'), 'utf8').trim();

// Minimal stub of the title bar component's render tail, in two minification
// schemes (compact-app-pc uses react=r/suffix=s/style=t; the lazy chunk uses
// react=i/suffix=o/style=t). Each ends with the `pendingUpdate ? <update> : null`
// slot the mac build renders.
// Built with plain concatenation (not a template literal) so the embedded
// backtick/`${}` and the exact `STR_NEW_VER"})))):null))` anchor are literal.
function stub(react, suffix, style) {
  return (
    react + '.a.createElement("div",{id:"titleBar",className:(this.props.className||" titlebar rel flx flx-al-c ")' +
    '+(X?" titlebar--display ":"")+(this.props.status&&this.props.status.isAppLock?" locked ":"")+"DARWIN"},' +
    react + '.a.createElement("div",{className:`title-name + macos ${A} ${' + suffix + '}`}),' +
    'this.props.loginMode?null:' + react + '.a.createElement(v.c,{className:' + suffix + '}),null,' +
    'this.state.pendingUpdate?' + react + '.a.createElement("div",{className:"titlebar__btns clickable",style:' + style + '},' +
    react + '.a.createElement(d.a,{textKey:"STR_NEW_VER"})))):null))}}t.b=X;'
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbctl-'));

for (const [react, suffix, style] of [['r', 's', 't'], ['i', 'o', 't']]) {
  const f = path.join(tmp, `bundle-${react}.js`);
  fs.writeFileSync(f, stub(react, suffix, style));

  assert.strictEqual(patchFile(f, template), 'patched', `${react}: should patch`);
  let c = fs.readFileSync(f, 'utf8');
  // controls spliced with this bundle's own locals
  assert(c.includes('fa-Lock_24_Line btn titlebar__menu__btn'), `${react}: lock button present`);
  assert(c.includes(`${react}.a.createElement("i",{className:\`fa fa-Minus_24_Line`), `${react}: minimize uses react var ${react}`);
  assert(c.includes('fa-Minus_24_Line') && c.includes('fa-Close_24_Line'), `${react}: min+close present`);
  // platform class flipped, macos dropped, null slot gone
  assert(c.includes('?" locked ":"")+"WIN32"'), `${react}: WIN32 class`);
  assert(!c.includes('+"DARWIN"'), `${react}: no DARWIN left`);
  assert(!c.includes('title-name + macos'), `${react}: macos class removed`);
  assert(!c.includes('STR_NEW_VER"})))):null))'), `${react}: null slot replaced`);
  // uses THIS bundle's suffix var inside the control className, not the template's 's'
  assert(c.includes('fa-Lock_24_Line btn titlebar__menu__btn ${' + suffix + '}'), `${react}: suffix var ${suffix} applied`);

  // idempotent
  assert.strictEqual(patchFile(f, template), 'already', `${react}: second run is a no-op`);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), c, `${react}: no double-splice`);
}

// fail-loud on anchor drift (title bar present, but no null slot)
const drift = path.join(tmp, 'drift.js');
fs.writeFileSync(drift, 'x.a.createElement("div",{id:"titleBar",className:"..."+"DARWIN"},x.a.createElement("span"))');
assert.throws(() => patchFile(drift, template), /anchor/, 'drift should throw');

// no title bar -> skip (not an error)
const other = path.join(tmp, 'other.js');
fs.writeFileSync(other, 'console.log("no title bar here")');
assert.strictEqual(patchFile(other, template), 'skip', 'non-titlebar bundle skipped');

fs.removeSync(tmp);
console.log('OK patch-titlebar-controls');
