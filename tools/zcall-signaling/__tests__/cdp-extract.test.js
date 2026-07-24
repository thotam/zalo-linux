const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'cdp-extract.js');
const { cookieHeader, findGetSecretKeyReturn } = require(MOD);

assert.strictEqual(cookieHeader([{ name: 'a', value: 'b' }, { name: 'c', value: 'd' }]), 'a=b; c=d', 'cookie header');
assert.strictEqual(cookieHeader([]), '', 'empty cookies');

// findGetSecretKeyReturn: locate "return le" inside getSecretKey on the correct line
const src = 'line0;\nfoo(){}static getSecretKey(){return le||bar(),le}baz();';
const loc = findGetSecretKeyReturn(src);
assert.ok(loc && loc.line === 1, 'found on line 1');
assert.ok(typeof loc.column === 'number' && loc.column > 0, 'has a column');
assert.strictEqual(findGetSecretKeyReturn('no match here'), null, 'null when absent');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK cdp-extract');
