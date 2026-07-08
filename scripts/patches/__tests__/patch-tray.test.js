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
  '(function(){if(Ae){Ae.isMinimized()?Ae.restore():Ae.show(),Ae.focus();const e=et.getInfoSizeWindow(Ae);return e}})();' +
  'if("darwin"===process.platform||"linux"===process.platform){h.setBadgeCount(t);"darwin"===process.platform&&!o&&t&&e<t&&h.dock.bounce()}else if("win32"===process.platform){if(m){const e=t&&i?f.createFromDataURL(i):null;e?m.setImage(e):m.setImage(l)}}' +
  'var J6F3={getTray:function(){return xe},defaultTrayImage:Nt};' +
  'const{getTray:d,defaultTrayImage:l}=n("j6F3");';

const f = path.join(tmp, 'main.js');
fs.writeFileSync(f, stub);

assert.strictEqual(patchMainJs(f), 'patched', 'should patch');
const c = fs.readFileSync(f, 'utf8');
assert(c.includes('if(J()===q||"linux"===process.platform){const t=s.Menu;'), 'edit1: gate opened');
assert(c.includes('c.join(te(),"apple-icon-57x57.png")).resize({width:44,height:44})'), 'edit2: icon resized');
assert(!c.includes('"favicon.ico"'), 'edit2: favicon.ico replaced');
assert(c.includes('Ae.focus();"linux"===process.platform&&setTimeout(function(){'), 'edit3: reveal toggle injected');
assert(c.includes('(Ae.unmaximize(),Ae.maximize(),Ae.focus())'), 'edit3: toggle body');
assert(c.includes('h.dock.bounce(),"linux"===process.platform&&m&&m.setImage(t>0&&_u?_u:l)'), 'edit4: tray badge on Linux');
assert(c.includes('defaultTrayImage:Nt,unreadTrayImage:p.createFromPath(c.join(te(),"favicon-tray-unread.png")).resize({width:44,height:44})'), 'edit5: unread image exported');
assert(c.includes('{getTray:d,defaultTrayImage:l,unreadTrayImage:_u}=n("j6F3")'), 'edit6: unread image imported');

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
