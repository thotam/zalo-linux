const assert = require('assert');
const addon = require('./load-addon');
for (const fn of [
  'getDirectorySizeSync', 'getDirectorySizeAsync',
  'getDirectorySizeTreeSync', 'getDirectorySizeTreeAsync',
  'getDirectorySizeByGlobSync', 'getDirectorySizeByGlobAsync',
  'detectHardlinksSync', 'detectHardlinksAsync',
  'detectFilesystemSync', 'detectFilesystemAsync',
  'cancelJob',
]) {
  assert.strictEqual(typeof addon[fn], 'function', `missing export: ${fn}`);
}
console.log('OK smoke: all 11 exports present');
