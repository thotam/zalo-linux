const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Runtime logging for the RE'd native libs (verify-native-libs-e39 branch).
//
// Every native lib the app uses is reached through the single aggregator
// app/native/nativelibs/index.js — the bundles do `require("../native/nativelibs")`
// and call `nativelibs.zjxl()`, `nativelibs.zimage()`, `nativelibs.dbUtils()`,
// `nativelibs.sqlite3()`, etc. This patch:
//
//   1. drops __zinstrument.js next to the aggregator (the logging shim; see
//      scripts/patches/data/zinstrument.js), and
//   2. wraps each accessor on the exported `instance` object so the lib it
//      returns is piped through instrument(name, lib) — logging every native
//      API call (CALL/RET/RESOLVE/REJECT/THROW/NEW) to ~/zalo-native-libs.log.
//
// Memoized per name: the accessor's underlying value is fetched once, wrapped
// once, and the same wrapped object is returned on every later call (require()
// already caches the module, so identity is preserved for the app).
//
// This is instrumentation-only — it changes no behaviour, and the shim fails
// open (any error inside it returns the raw lib). Intended for the verify
// branch; not part of the shipping E39 build.
// ---------------------------------------------------------------------------

const NATIVELIBS = path.join(__dirname, '..', '..', 'app', 'native', 'nativelibs');
const AGG = path.join(NATIVELIBS, 'index.js');
const SHIM_SRC = path.join(__dirname, 'data', 'zinstrument.js');
const SHIM_DST = path.join(NATIVELIBS, '__zinstrument.js');

const MARKER = '/*__znative_log__*/';

// The aggregator declares `var instance = module.exports = { ... }`. We append,
// after that literal, a self-invoking block that re-wraps every function-valued
// accessor on `instance`. Anchor on the assignment so we fail loud if the shape
// changes.
const ANCHOR = 'var instance = module.exports = {';

const INJECT = '\n' + MARKER + '\n' +
  ';(function(){try{' +
  'var __ins=require("./__zinstrument.js");' +
  'var __cache=Object.create(null);' +
  'Object.keys(instance).forEach(function(__name){' +
  'if(typeof instance[__name]!=="function")return;' +
  'var __orig=instance[__name];' +
  'instance[__name]=function(){' +
  'if(__name in __cache)return __cache[__name];' +
  'var __lib=__orig.apply(this,arguments);' +
  'var __w=__ins(__name,__lib);' +
  '__cache[__name]=__w;' +
  'return __w;};});' +
  '}catch(__e){try{require("fs").appendFileSync(' +
  'require("path").join(require("os").homedir(),"zalo-native-libs.log"),' +
  '"INSTRUMENT-WIRE-ERROR "+(__e&&__e.message)+"\\n");}catch(_){}}})();\n';

function patchAggregator(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(MARKER)) return 'already';
  const n = s.split(ANCHOR).length - 1;
  if (n !== 1) {
    throw new Error(
      `patch-native-lib-logging: expected exactly 1 \`${ANCHOR}\` in the nativelibs ` +
      `aggregator, found ${n} — aggregator shape changed, re-derive.`
    );
  }
  // Append the wiring at end of file (the block references `instance`, which is
  // in scope for the whole module).
  s = s + INJECT;
  fs.writeFileSync(file, s, 'utf8');
  return 'wired';
}

async function main() {
  if (!fs.existsSync(AGG)) {
    throw new Error(`patch-native-lib-logging: ${logger.formatPath(AGG)} not found (run extract first)`);
  }
  if (!fs.existsSync(SHIM_SRC)) {
    throw new Error(`patch-native-lib-logging: shim template ${logger.formatPath(SHIM_SRC)} missing`);
  }
  fs.copyFileSync(SHIM_SRC, SHIM_DST);
  const r = patchAggregator(AGG);
  logger.success(`native-lib runtime logging: ${r} (shim -> ${path.basename(SHIM_DST)})`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchAggregator };
