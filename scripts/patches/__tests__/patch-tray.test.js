const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { patchMainJs } = require('../patch-tray.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-'));

// Stub containing the three literal anchors patch-tray targets.
const stub =
  'G.requestQuitApp()};if(J()===q){const t=s.Menu;xe||(xe=new u(Nt));}' +
  'const Nt=p.createFromPath(c.join(te(),"favicon.ico")),At={};' +
  'function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),void e.focus();return 0}}';

const f = path.join(tmp, 'main.js');
fs.writeFileSync(f, stub);

assert.strictEqual(patchMainJs(f), 'patched', 'should patch');
const c = fs.readFileSync(f, 'utf8');
assert(c.includes('if(J()===q||"linux"===process.platform){const t=s.Menu;'), 'edit1: gate opened');
assert(c.includes('c.join(te(),"apple-icon-57x57.png")).resize({width:44,height:44})'), 'edit2: icon resized');
assert(!c.includes('"favicon.ico"'), 'edit2: favicon.ico replaced');
assert(c.includes('e.show(),"linux"===process.platform&&e.isMaximized()&&setTimeout'), 'edit3: reveal toggle injected');
assert(c.includes('(e.unmaximize(),e.maximize())'), 'edit3: toggle body');

// idempotent
assert.strictEqual(patchMainJs(f), 'already', 'second run no-op');
assert.strictEqual(fs.readFileSync(f, 'utf8'), c, 'no double patch');

// fail-loud: an anchor missing (drift) -> throw
const drift = path.join(tmp, 'drift.js');
fs.writeFileSync(drift,
  'G.requestQuitApp()};if(J()===q){const t=s.Menu;}' +
  'const Nt=p.createFromPath(c.join(te(),"favicon.ico"));'); // no en() anchor
assert.throws(() => patchMainJs(drift), /show-from-tray reveal: expected exactly 1 anchor, found 0/, 'drift throws');

fs.removeSync(tmp);
console.log('OK patch-tray');
