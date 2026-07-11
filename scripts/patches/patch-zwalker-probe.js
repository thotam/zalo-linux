const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// zwalker runtime probe (verify-native-libs-e39 branch only).
//
// zwalker's cleanup feature is server-gated OFF (cleanup.enable default false), so the
// app never calls the GC on its own — the logging harness would therefore never capture
// a single zwalker CALL, even though the addon loads fine. To prove the reconstructed
// addon actually RUNS inside the real Electron process (not just "the .node loads"), this
// patch appends a one-shot probe to the nativelibs aggregator that, a few seconds after
// startup, exercises all 5 functions against a throwaway temp directory and logs the
// results to ~/zalo-native-libs.log.
//
// It goes through the INSTRUMENTED accessor `instance.zwalker()` (wired by
// patch-native-lib-logging, which must run first), so each call also shows up as a
// standard CALL/RET line. It touches ZERO user data — everything happens under
// os.tmpdir()/zwalker-probe-* and is removed afterwards. Instrumentation/probe only;
// never part of the shipping build.
// ---------------------------------------------------------------------------

const NATIVELIBS = path.join(__dirname, '..', '..', 'app', 'native', 'nativelibs');
const AGG = path.join(NATIVELIBS, 'index.js');
const LOG_MARKER = '/*__znative_log__*/';
const MARKER = '/*__zwalker_probe__*/';

// Appended AFTER the logging wiring so `instance.zwalker()` is already instrumented.
// Runs once per process that loads the aggregator (the shared-worker loads it early for
// the message DB), deferred 5s so it never disturbs startup. Sync zwalker fns are called
// sequentially; the whole thing is wrapped fail-open.
const PROBE = '\n' + MARKER + '\n' +
  ';(function(){try{\n' +
  'var fs=require("fs"),os=require("os"),path=require("path");\n' +
  'var LOG=process.env.ZALO_NATIVE_LOG||path.join(os.homedir(),"zalo-native-libs.log");\n' +
  'var log=function(m){try{fs.appendFileSync(LOG,"ZWALKER-PROBE "+m+"\\n");}catch(_){}}; \n' +
  'setTimeout(function(){try{\n' +
  '  var root=fs.mkdtempSync(path.join(os.tmpdir(),"zwalker-probe-"));\n' +
  '  fs.mkdirSync(path.join(root,"Cache"),{recursive:true});\n' +
  '  fs.mkdirSync(path.join(root,"zcloud"),{recursive:true});\n' +
  '  fs.mkdirSync(path.join(root,"empty","nested"),{recursive:true});\n' +
  '  fs.writeFileSync(path.join(root,"Cache","a.jpg"),Buffer.alloc(100,1));\n' +
  '  fs.writeFileSync(path.join(root,"Cache","b.jpg"),Buffer.alloc(200,1));\n' +
  '  fs.writeFileSync(path.join(root,"zcloud","c.mp4"),Buffer.alloc(400,1));\n' +
  '  fs.writeFileSync(path.join(root,"loose.dat"),Buffer.alloc(50,1));\n' +
  '  var tracking=[path.join(root,"Cache","**"),path.join(root,"zcloud","**"),"**"];\n' +
  '  var zw=instance.zwalker();\n' +
  '  Promise.resolve()\n' +
  '   .then(function(){return zw.scanDirectory(root,tracking);})\n' +
  '   .then(function(r){log("scan="+JSON.stringify(r));\n' +
  '     return zw.updateReferenceMessageId(root,[{filePath:path.join(root,"Cache","a.jpg"),id:"m1"},{filePath:path.join(root,"Cache","b.jpg"),id:"m2"}]);})\n' +
  '   .then(function(r){log("update="+JSON.stringify(r));\n' +
  '     return zw.statUnmarkedFiles(root,[],tracking,[259200,604800,1209600]);})\n' +
  '   .then(function(r){log("stat="+JSON.stringify(r));\n' +
  '     return zw.deleteHomelessFiles(root,[],tracking,true);})\n' +
  '   .then(function(r){log("deleteHomeless="+JSON.stringify(r));\n' +
  '     return zw.deleteEmptyFolders(root);})\n' +
  '   .then(function(r){log("deleteEmpty="+JSON.stringify(r));\n' +
  '     var survived=fs.existsSync(path.join(root,"Cache","a.jpg"))&&fs.existsSync(path.join(root,"Cache","b.jpg"));\n' +
  '     var homelessGone=!fs.existsSync(path.join(root,"zcloud","c.mp4"))&&!fs.existsSync(path.join(root,"loose.dat"));\n' +
  '     log("VERDICT markedSurvived="+survived+" homelessDeleted="+homelessGone+" root="+root);\n' +
  '     try{fs.rmSync(root,{recursive:true,force:true});}catch(_){}\n' +
  '     log("done OK");})\n' +
  '   .catch(function(e){log("ERROR "+(e&&e.message?e.message:e));try{fs.rmSync(root,{recursive:true,force:true});}catch(_){}});\n' +
  '}catch(e){log("SETUP-ERROR "+(e&&e.message?e.message:e));}},5000);\n' +
  '}catch(__e){}})();\n';

function patchAggregator(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(MARKER)) return 'already';
  if (!s.includes(LOG_MARKER)) {
    throw new Error('patch-zwalker-probe: logging wiring not found — run patch-native-lib-logging first');
  }
  fs.writeFileSync(file, s + PROBE, 'utf8');
  return 'wired';
}

async function main() {
  if (!fs.existsSync(AGG)) {
    throw new Error(`patch-zwalker-probe: ${logger.formatPath(AGG)} not found (run extract first)`);
  }
  const r = patchAggregator(AGG);
  logger.success(`zwalker probe ${r === 'already' ? 'already present' : 'wired into aggregator'}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchAggregator };
