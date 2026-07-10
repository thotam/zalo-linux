// Runtime instrumentation for the RE'd native libs (verify branch).
//
// Copied verbatim into app/native/nativelibs/__zinstrument.js by
// scripts/patches/patch-native-lib-logging.js. The aggregator index.js pipes
// each lib it hands to the app through instrument(name, lib) so every native
// API call is logged. Goal: prove which RE'd libs (zjxl, zimage, zfile,
// sqlite3, db-cross-v4/dbUtils, v8-profiles, zcall, zwalker, mp4thumb, ...)
// are actually EXERCISED at runtime on Electron 39, and whether each call
// succeeds — the E39 upgrade forces the native image path (Chromium 142 can't
// decode JPEG-XL), so we need runtime evidence, not just "the .node loads".
//
// Logs to a FILE, not console: Zalo overrides console in the packaged app.
// Path: $ZALO_NATIVE_LOG or ~/zalo-native-libs.log (main + renderer both append;
// pid tags disambiguate the process).
//
// SAFETY: only OWN-ENUMERABLE properties are wrapped. Native class instances
// (sqlite3 Database/Statement) keep their methods on the prototype, so those
// are never touched — the DB hot path runs unwrapped. Only constructors and
// plain-object API functions get a logging shim. Per-label sampling (first few
// calls in full, then every Nth) keeps the log bounded on hot paths.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = process.env.ZALO_NATIVE_LOG || path.join(os.homedir(), 'zalo-native-libs.log');
const PID = process.pid;
const ROLE = process.type || 'node'; // 'browser' (main) | 'renderer' | ...
const BOOT = Date.now();

// Sampling: log the first FULL calls of each label, then 1-in-EVERY afterwards.
const FULL = 4;
const EVERY = 50;
const counts = Object.create(null);

let headerWritten = false;
function ensureHeader() {
  if (headerWritten) return;
  headerWritten = true;
  const v = process.versions || {};
  append(
    '\n===== zalo native-lib log | pid=' + PID + ' role=' + ROLE +
    ' electron=' + (v.electron || '?') + ' chrome=' + (v.chrome || '?') +
    ' node=' + (v.node || '?') + ' ====='
  );
}

function append(line) {
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* never let logging break the app */ }
}

function ts() {
  return '+' + ((Date.now() - BOOT) / 1000).toFixed(3) + 's';
}

// Returns the occurrence number to log (truthy) or 0 to skip (sampled out).
function sample(label) {
  const n = (counts[label] = (counts[label] || 0) + 1);
  if (n <= FULL) return n;
  if (n % EVERY === 0) return n;
  return 0;
}

function emit(kind, label, extra) {
  const n = sample(kind + ' ' + label);
  if (!n) return;
  ensureHeader();
  append(
    ts() + ' [' + ROLE + ':' + PID + '] ' + kind + ' ' + label +
    (n > FULL ? ' (#' + n + ')' : '') + (extra ? ' ' + extra : '')
  );
}

function summarize(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === 'string') return 'str(' + v.length + ')';
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'symbol') return 'sym';
  if (t === 'function') return 'fn:' + (v.name || 'anon');
  if (Buffer.isBuffer(v)) return 'buf(' + v.length + ')';
  if (ArrayBuffer.isView(v)) return v.constructor.name + '(' + v.length + ')';
  if (v instanceof Error) return 'Error(' + v.message + ')';
  if (Array.isArray(v)) {
    if (depth > 1) return 'arr(' + v.length + ')';
    return '[' + v.slice(0, 4).map(function (x) { return summarize(x, depth + 1); }).join(',') +
      (v.length > 4 ? ',…' : '') + ']';
  }
  if (t === 'object') {
    if (typeof v.then === 'function') return 'Promise';
    if (depth > 1) return '{…}';
    const keys = Object.keys(v).slice(0, 6);
    return '{' + keys.map(function (k) { return k + ':' + summarize(v[k], depth + 1); }).join(',') +
      (Object.keys(v).length > 6 ? ',…' : '') + '}';
  }
  return t;
}

function argsSummary(args) {
  const a = [];
  for (let i = 0; i < args.length && i < 6; i++) a.push(summarize(args[i]));
  return '(' + a.join(', ') + ')';
}

const MAX_DEPTH = 4;

function wrapFunction(label, fn, depth) {
  function shim() {
    const start = Date.now();
    const args = arguments;
    if (new.target) {
      emit('NEW', label, argsSummary(args));
      const inst = Reflect.construct(fn, args, new.target);
      // instance methods live on the prototype -> walk() leaves them alone;
      // only own props (rare) get wrapped.
      return walk(label, inst, depth + 1);
    }
    emit('CALL', label, argsSummary(args));
    let r;
    try {
      r = fn.apply(this, args);
    } catch (e) {
      emit('THROW', label, (e && e.message) || String(e));
      throw e;
    }
    if (r && typeof r.then === 'function') {
      return r.then(
        function (val) {
          emit('RESOLVE', label, '(' + (Date.now() - start) + 'ms) ' + summarize(val));
          return walk(label, val, depth + 1);
        },
        function (err) {
          emit('REJECT', label, (err && err.message) || String(err));
          return Promise.reject(err);
        }
      );
    }
    emit('RET', label, '(' + (Date.now() - start) + 'ms) ' + summarize(r));
    return walk(label, r, depth + 1);
  }
  // preserve constructor identity/instanceof and static props
  shim.prototype = fn.prototype;
  try {
    Object.getOwnPropertyNames(fn).forEach(function (k) {
      if (k === 'length' || k === 'name' || k === 'prototype' || k === 'arguments' || k === 'caller') return;
      try { shim[k] = fn[k]; } catch (_) {}
    });
  } catch (_) {}
  return shim;
}

function walk(label, val, depth) {
  if (depth > MAX_DEPTH) return val;
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === 'function') return wrapFunction(label, val, depth);
  if (t !== 'object') return val;
  // never proxy these — copying loses internal slots / breaks identity
  if (Buffer.isBuffer(val) || ArrayBuffer.isView(val) || val instanceof Error) return val;
  // A promise handed to walk directly (e.g. an accessor returning
  // Promise<{Image:{...}}>): chain in so the resolved value is instrumented too.
  if (typeof val.then === 'function') {
    return val.then(function (v) {
      emit('RESOLVE', label, summarize(v));
      return walk(label, v, depth + 1);
    });
  }

  let keys;
  try { keys = Object.keys(val); } catch (_) { return val; }
  const proxy = Object.create(Object.getPrototypeOf(val) || Object.prototype);
  let wrappedAny = false;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let d;
    try { d = Object.getOwnPropertyDescriptor(val, k); } catch (_) { continue; }
    if (!d) continue;
    if (typeof d.get === 'function') {
      const getter = d.get;
      Object.defineProperty(proxy, k, {
        enumerable: d.enumerable,
        configurable: true,
        get: function () { return walk(label + '.' + k, getter.call(val), depth + 1); },
      });
      wrappedAny = true;
    } else if (typeof d.value === 'function') {
      proxy[k] = wrapFunction(label + '.' + k, d.value, depth);
      wrappedAny = true;
    } else if (d.value && typeof d.value === 'object' &&
               !Buffer.isBuffer(d.value) && !ArrayBuffer.isView(d.value)) {
      proxy[k] = walk(label + '.' + k, d.value, depth + 1);
      wrappedAny = true;
    } else {
      try { proxy[k] = d.value; } catch (_) {}
    }
  }
  return wrappedAny ? proxy : val;
}

module.exports = function instrument(name, lib) {
  try {
    emit('LOAD', name, '-> ' + summarize(lib));
    return walk(name, lib, 0);
  } catch (e) {
    append(ts() + ' INSTRUMENT-ERROR ' + name + ' ' + (e && e.message));
    return lib; // fail open: never break the app for logging
  }
};
