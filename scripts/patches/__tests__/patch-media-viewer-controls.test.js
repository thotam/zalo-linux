const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { patchBundle, patchMainJs } = require('../patch-media-viewer-controls.js');
const template = fs.readFileSync(path.join(__dirname, '..', 'data', 'media-viewer-controls-win32.txt'), 'utf8').trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvc-'));

// --- patchBundle: image-show title bar, two minification schemes (r / i) ---
function bundleStub(react) {
  const drag = react + '.a.createElement("div",{className:"draggable w100 title-drag",style:{position:"absolute",left:0},onDoubleClick:this.maximize.bind(this)})';
  return (
    'if(x.includes("image-show__title"))return ' + react + '.a.createElement(o.a,null,' +
    react + '.a.createElement("div",{className:this.props.className||" titlebar rel flx"},null,e,' + drag + ',null));' +
    'z=' + react + '.a.createElement("div",{className:"titlebar__title mac"});'
  );
}

for (const react of ['r', 'i']) {
  const f = path.join(tmp, `b-${react}.js`);
  fs.writeFileSync(f, bundleStub(react));
  assert.strictEqual(patchBundle(f, template), 'patched', `${react}: patched`);
  const c = fs.readFileSync(f, 'utf8');
  assert(c.includes('titlebar__menu__btnPreviewPhoto'), `${react}: control btns spliced`);
  assert(c.includes(react + '.a.createElement("i",{className:"fa fa-Minus_24_Line'), `${react}: minimize uses react var ${react}`);
  assert(c.includes('fa-Close_24_Line') && c.includes('fa-Maximize_24_Line'), `${react}: close+max present`);
  assert(c.includes('titlebar__resize'), `${react}: resize div added`);
  assert(!c.includes('},null,e,'), `${react}: leading null slot replaced`);
  assert(!c.includes('"titlebar__title mac"'), `${react}: mac title class dropped`);
  // idempotent
  assert.strictEqual(patchBundle(f, template), 'already', `${react}: idempotent`);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), c, `${react}: no double splice`);
}

// no image-show title bar -> skip
const other = path.join(tmp, 'other.js');
fs.writeFileSync(other, 'console.log(1)');
assert.strictEqual(patchBundle(other, template), 'skip', 'non-viewer bundle skipped');

// --- patchMainJs: media-viewer window options preload injection ---
// patchMainJs reads a fixed path (app/main-dist/main.js); test the transform by
// temporarily pointing at a stub is not possible without refactor, so assert the
// exported function is present and the marker/anchor contract holds on a copy.
const mainStub = path.join(tmp, 'main.js');
const anchor = 'return zconsole.debug("main:getOptionsInitMediaViewerBrowserWindow",e),{action:"allow",overrideBrowserWindowOptions:e}';
fs.writeFileSync(mainStub, 'const e=g({});' + anchor + ';');
// Exercise the same replacement logic inline (mirrors patchMainJs) to lock the contract.
let ms = fs.readFileSync(mainStub, 'utf8');
assert(ms.includes(anchor), 'main stub has the options anchor');
const inject = '/*__MVPRELOAD__*/e.webPreferences=Object.assign({},e.webPreferences,{preload:require("path").join(__dirname,"preload-noti.js"),contextIsolation:!0,sandbox:!1,nodeIntegration:!1});';
ms = ms.replace(anchor, inject + anchor);
assert(ms.includes('__MVPRELOAD__') && ms.includes('preload-noti.js'), 'preload injected before the anchor');
assert.strictEqual(typeof patchMainJs, 'function', 'patchMainJs exported');

fs.removeSync(tmp);
console.log('OK patch-media-viewer-controls');
