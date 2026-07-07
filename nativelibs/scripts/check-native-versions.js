#!/usr/bin/env node
// Repo-wide native-dependency version tracker.
//
// WHY: several Zalo native modules bundle or link specific third-party library
// versions (zjxl → libjxl 0.9.3 / libjpeg-turbo 3.1.1 / OpenCV 4.12; zimage →
// libvips 42; etc.). Our Linux port only stays byte-identical / ABI-correct if we
// track those versions. When Zalo ships a new DMG that bumps any of them, we need
// to KNOW — silently building against a different version is how output diverges.
//
// This script scans every extracted mac native module, reads the real versions
// out of the Mach-O binaries (each bundled dylib's own version, plus the versioned
// libraries every .node/.dylib links against), and DIFFS the result against a
// committed baseline manifest (nativelibs/expected-versions.json). Any add / remove
// / version-change is reported. Run it after SETUP; it also runs automatically at
// the end of SETUP as a notice.
//
// Lessons baked in:
//  - Do NOT trust libturbojpeg's Mach-O version (it's the TurboJPEG *API* version
//    0.4.0, not the libjpeg-turbo release 3.1.1) — read the embedded
//    "libjpeg-turbo version X.Y.Z" string instead.
//  - OS-provided libs (libSystem, libc++, libobjc, system frameworks) are excluded
//    so macOS-SDK bumps don't cause false drift.
//
// Usage:
//   node nativelibs/scripts/check-native-versions.js            # report + diff vs baseline (exit 1 on drift)
//   node nativelibs/scripts/check-native-versions.js --update   # rewrite the baseline manifest to current
//   node nativelibs/scripts/check-native-versions.js --quiet    # only print on drift (used by SETUP notice)
//   node nativelibs/scripts/check-native-versions.js --notice   # never exit nonzero (informational SETUP mode)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const MODULES_DIR = path.join(ROOT, 'app', 'native', 'nativelibs');
const MANIFEST = path.join(ROOT, 'nativelibs', 'expected-versions.json');

const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update');
const QUIET = args.has('--quiet');
const NOTICE = args.has('--notice'); // informational: report drift but never exit nonzero

// OS libraries whose versions we don't pin — excluding them avoids false drift on
// macOS SDK bumps. Matched by install-name basename prefix.
const OS_LIB_PREFIXES = [
  'libSystem', 'libc++', 'libc++abi', 'libobjc', 'libresolv', 'libiconv',
  'libcompression', 'libz.', 'libnetwork', 'libenergytrace', 'libxml2',
];

// ---- Mach-O parsing (thin + fat, 64-bit) ----------------------------------

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe; // big-endian on disk
const FAT_MAGIC_LE = 0xbebafeca;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_ID_DYLIB = 0x0d;
const DYLIB_CMDS = new Set([0x0c /*LOAD*/, 0x0d /*ID*/, 0x18 /*LOAD_WEAK*/, 0x1f /*REEXPORT*/, 0x20 /*LAZY_LOAD*/, 0x23 /*UPWARD*/]);

function verStr(u32) {
  return `${(u32 >>> 16) & 0xffff}.${(u32 >>> 8) & 0xff}.${u32 & 0xff}`;
}

// Return {sliceOffset, littleEndian} for the x86_64 Mach-O in a file (handles fat).
function machoSlice(buf) {
  const magic = buf.readUInt32BE(0);
  if (magic === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    for (let i = 0; i < n; i++) {
      const off = 8 + i * 20;
      const cputype = buf.readUInt32BE(off);
      const offset = buf.readUInt32BE(off + 8);
      if (cputype === CPU_TYPE_X86_64) return { off: offset };
    }
    return { off: buf.readUInt32BE(8 + 8) }; // fall back to first slice
  }
  const le = buf.readUInt32LE(0);
  if (le === MH_MAGIC_64 || le === MH_CIGAM_64) return { off: 0 };
  if (magic === FAT_MAGIC_LE) return { off: 0 }; // unusual; treat as thin
  return null;
}

// Parse a Mach-O: returns { id: "x.y.z"|null, deps: [{name, version}] }.
function parseMacho(file) {
  const buf = fs.readFileSync(file);
  const slice = machoSlice(buf);
  if (!slice) return null;
  const base = slice.off;
  const magic = buf.readUInt32LE(base);
  if (magic !== MH_MAGIC_64) return null; // only 64-bit LE handled
  const ncmds = buf.readUInt32LE(base + 16);
  let off = base + 32; // sizeof(mach_header_64)
  let id = null;
  const deps = [];
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (DYLIB_CMDS.has(cmd)) {
      const nameOff = buf.readUInt32LE(off + 8);
      const current = buf.readUInt32LE(off + 16);
      let end = off + nameOff;
      while (end < off + cmdsize && buf[end] !== 0) end++;
      const name = buf.toString('utf8', off + nameOff, end);
      const bn = name.split('/').pop();
      if (cmd === LC_ID_DYLIB) id = verStr(current);
      else deps.push({ name: bn, version: verStr(current) });
    }
    off += cmdsize;
  }
  return { id, deps };
}

function isOsLib(basename) {
  return OS_LIB_PREFIXES.some(p => basename.startsWith(p));
}

// libjpeg-turbo's real release version lives only in an embedded string.
function turboRelease(file) {
  try {
    const out = execSync(`strings -a ${JSON.stringify(file)}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = out.match(/libjpeg-turbo version ([0-9]+\.[0-9]+\.[0-9]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---- Snapshot -------------------------------------------------------------

// Build { module: { bundled: {dylibBasename: version}, links: {libBasename: version}, notes: {} } }
function snapshot() {
  const snap = {};
  if (!fs.existsSync(MODULES_DIR)) {
    console.error(`check-native-versions: ${MODULES_DIR} not found — run SETUP first (extracts app.asar.unpacked).`);
    process.exit(NOTICE ? 0 : 1);
  }
  for (const mod of fs.readdirSync(MODULES_DIR).sort()) {
    const dir = path.join(MODULES_DIR, mod);
    if (!fs.statSync(dir).isDirectory()) continue;
    // Only look at the x86_64 mac artifacts (darwin_x64), ignoring arm64 to keep
    // one canonical set; if only arm64 exists, fall back to it.
    const machos = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d)) {
        const p = path.join(d, e);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          if (/darwin_arm64|win32/.test(p)) continue; // skip non-x64 mac + windows
          walk(p);
        } else if (/\.(dylib|node)$/.test(e)) {
          machos.push(p);
        }
      }
    })(dir);

    const bundled = {}; // this module's own bundled dylibs -> their version
    const links = {};   // versioned libs the module links against -> version
    for (const f of machos) {
      const bn = path.basename(f);
      const parsed = parseMacho(f);
      if (!parsed) continue;
      if (bn.endsWith('.dylib') && parsed.id) {
        // A bundled third-party/self dylib. Prefer the turbojpeg string for it.
        bundled[bn] = bn.startsWith('libturbojpeg') ? (turboRelease(f) || parsed.id) : parsed.id;
      }
      for (const d of parsed.deps) {
        if (isOsLib(d.name)) continue;
        if (!/\.\d+.*\.dylib$|\.dylib$/.test(d.name)) continue;
        // Prefer real turbojpeg release when we can resolve the linked file.
        let v = d.version;
        if (d.name.startsWith('libturbojpeg')) {
          const sib = machos.find(m => path.basename(m) === d.name);
          if (sib) v = turboRelease(sib) || v;
        }
        // Keep the highest-signal value if seen multiple times.
        if (!(d.name in links)) links[d.name] = v;
      }
    }
    // A module's .node links the very dylibs it bundles — drop those from `links`
    // so the report only shows EXTERNAL linkage (the signal for .node-only modules).
    for (const k of Object.keys(links)) if (k in bundled) delete links[k];
    if (Object.keys(bundled).length || Object.keys(links).length) {
      snap[mod] = { bundled, links };
    }
  }
  return snap;
}

// ---- Diff -----------------------------------------------------------------

function diff(base, cur) {
  const changes = [];
  const mods = new Set([...Object.keys(base), ...Object.keys(cur)]);
  for (const mod of [...mods].sort()) {
    const b = base[mod] || { bundled: {}, links: {} };
    const c = cur[mod] || { bundled: {}, links: {} };
    for (const kind of ['bundled', 'links']) {
      const keys = new Set([...Object.keys(b[kind] || {}), ...Object.keys(c[kind] || {})]);
      for (const k of [...keys].sort()) {
        const ov = (b[kind] || {})[k];
        const nv = (c[kind] || {})[k];
        if (ov === nv) continue;
        if (ov === undefined) changes.push({ mod, kind, lib: k, from: '(new)', to: nv });
        else if (nv === undefined) changes.push({ mod, kind, lib: k, from: ov, to: '(removed)' });
        else changes.push({ mod, kind, lib: k, from: ov, to: nv });
      }
    }
  }
  return changes;
}

function printSnapshot(snap) {
  for (const mod of Object.keys(snap).sort()) {
    const { bundled, links } = snap[mod];
    const b = Object.entries(bundled);
    const l = Object.entries(links);
    if (!b.length && !l.length) continue;
    console.log(`\n  ${mod}`);
    for (const [k, v] of b) console.log(`    bundled  ${k.padEnd(30)} ${v}`);
    for (const [k, v] of l) console.log(`    links    ${k.padEnd(30)} ${v}`);
  }
}

// ---- zjxl PINS cross-check (are we still building what the mac ships?) -----

function zjxlPinsCheck(snap) {
  let pins;
  try { pins = require('../zjxl/scripts/deps-hash.js').PINS; } catch { return []; }
  const z = snap.zjxl;
  if (!z) return [];
  const macOf = re => {
    const k = Object.keys(z.bundled).find(n => re.test(n));
    return k ? z.bundled[k] : null;
  };
  const map = [
    ['libjxl', macOf(/^libjxl\.\d/)],
    ['highway', macOf(/^libhwy/)],
    ['brotli', macOf(/^libbrotlicommon/)],
    ['libjpeg_turbo', macOf(/^libturbojpeg/)],
    ['opencv', macOf(/^libopencv_core/)],
  ];
  const out = [];
  for (const [pin, mac] of map) {
    if (mac && pins[pin] && mac !== pins[pin]) out.push({ pin, mac, pinned: pins[pin] });
  }
  return out;
}

// ---- Main -----------------------------------------------------------------

const cur = snapshot();

if (UPDATE) {
  fs.writeFileSync(MANIFEST, JSON.stringify(cur, null, 2) + '\n');
  console.log(`Baseline written: ${path.relative(ROOT, MANIFEST)}`);
  printSnapshot(cur);
  process.exit(0);
}

const base = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const changes = diff(base, cur);
const pinDrift = zjxlPinsCheck(cur);

if (!changes.length && !pinDrift.length) {
  if (!QUIET) { console.log('Native library versions match the baseline manifest.'); printSnapshot(cur); }
  process.exit(0);
}

// Drift found — notify.
console.error('\n========================================================================');
console.error(' NATIVE LIBRARY VERSION DRIFT DETECTED');
console.error('========================================================================');
if (changes.length) {
  console.error('\nThe mac bundle differs from nativelibs/expected-versions.json:\n');
  console.error('  MODULE           KIND     LIBRARY                        BASELINE -> MAC');
  console.error('  ' + '-'.repeat(78));
  for (const c of changes) {
    console.error(`  ${c.mod.padEnd(16)} ${c.kind.padEnd(8)} ${c.lib.padEnd(30)} ${String(c.from).padEnd(12)} -> ${c.to}`);
  }
}
if (pinDrift.length) {
  console.error('\nzjxl: our build PINS no longer match the mac bundle (breaks byte-identical output):\n');
  for (const d of pinDrift) {
    console.error(`  ${d.pin.padEnd(16)} pinned ${String(d.pinned).padEnd(10)} mac ${d.mac}`);
  }
  console.error('\n  -> update PINS in nativelibs/zjxl/scripts/deps-hash.js to the mac values,');
  console.error('     re-run build-deps.sh, and re-verify re_params.h (encoder/decoder libs).');
}
console.error('\nIf these changes are expected (you updated to a new Zalo build), refresh the');
console.error('baseline with:  node nativelibs/scripts/check-native-versions.js --update');
console.error('========================================================================\n');

process.exit(NOTICE ? 0 : 1);
