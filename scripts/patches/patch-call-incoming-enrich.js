const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// The render's CallController.handleControl(e) is the only place an INCOMING event (`e.act==="request"`)
// gets forwarded to the native/main-process engine. It builds `const t={type:"control",data:e}` then
// `this._sendToNative(t)` — no enrichment: the engine only ever sees the caller's raw uid
// (e.data.fromId / e.data.uidN). Our engine's `startIncoming` reads `ctrl._caller={name,avatar}` to
// populate the incoming-call window; without this patch it falls back to showing the bare uid.
//
// We inject a resolve step immediately BEFORE that anchor so `e._caller` is set before forwarding.
//
// Selector confirmed via RE (spike, `default-login-main-startup-shared-worker-znotification` chunk):
// the SAME CallController class (same anonymous-class scope as handleControl, ~450 chars downstream
// in the sibling `handleRequest` method) already calls `T.default.getMiniInfo(uid)` and
// `T.default.getDName(uid)` via the SAME `T` import alias that is in scope at the anchor:
//   getInitialData(e): "...let r=e||T.default.getUidMe();const c=T.default.getMiniInfo(r)||{};
//                        return {...local:{id:r,avatar:c.avatar,name:c.dName}...}"
//   handleRequest "getAliasName" case: "const e=T.default.getDName(n.noisedId)..."
// This proves, in-scope: `T.default.getMiniInfo(uid)` returns a (possibly falsy) mini-profile object
// with `.dName` (display name) and `.avatar` fields — exactly the shape our engine expects, and it is
// reachable as a module-level alias (not `this.<method>`; `this.getProfileByIdFromCache` was checked
// and found to belong to an UNRELATED class ~1.8M chars away in the same bundle — NOT this scope).
//
// BUT the anchor `const t={type:"control",data:e}` is present in 4 separate webpack bundles under
// app/pc-dist + app/pc-dist/lazy (the active `...znotification...` chunk plus `compact-app-pc`,
// `sync-v2-sub-worker`, `search-worker`), and webpack's minifier assigns a DIFFERENT single-letter
// local alias to the contact-store module per bundle — `T` in the znotification chunk, but `b` in
// the other three (confirmed by grep). A hardcoded `T.default.getMiniInfo` therefore silently no-ops
// (the injected block is try/catch-guarded, so it just never sets `e._caller`) in every bundle except
// the one where the alias happens to be `T`. Whichever bundle actually carries the LIVE call
// controller varies by build, so we cannot just special-case one bundle — we detect the alias FROM
// EACH BUNDLE'S OWN SOURCE and inject a per-bundle snippet using that bundle's real alias.
//
// Whole block is try/catch-guarded: if resolution throws or returns nothing, `e._caller` is simply
// never set and the incoming event is still forwarded as-is (engine falls back to showing the uid) —
// this patch must never break call forwarding.
const REPO = path.join(__dirname, '..', '..');
const GLOB_DIRS = [path.join(REPO, 'app', 'pc-dist', 'lazy'), path.join(REPO, 'app', 'pc-dist')];
const MARKER = '__zcallEnrich';
const ANCHOR = 'const t={type:"control",data:e}';

// Pure: find the local webpack alias this bundle uses for the contact-store module, by locating an
// existing in-bundle call to `<alias>.default.getMiniInfo(` (preferred — same shape our injected
// snippet needs) or, failing that, `<alias>.default.getDName(` (same module, different method).
//
// IMPORTANT: search only a WINDOW around the ANCHOR, not the whole file. Verified against the real
// bundles: these are 16MB+ webpack bundles containing MANY unrelated classes that independently
// import the contact-store module under their OWN local alias (e.g. compact-app-pc has `A`, `b`, `c`
// all calling `.default.getMiniInfo(` at different, unrelated offsets). A naive "first match anywhere
// in the file" regex picks up whichever alias happens to appear first in bundle order — which is very
// likely NOT the alias in scope at the CallController anchor, so the injected call would throw a
// ReferenceError at runtime (harmless, since it's try/catch-wrapped, but it silently defeats the
// enrichment). The alias that is actually in scope at the anchor is the nearest match — confirmed
// live: `T` ~688 chars after the anchor in the znotification chunk, `b` ~ a few hundred chars away in
// the other 3 bundles (same CallController class, sibling handleRequest method per the RE notes
// above). A window of a few thousand chars comfortably covers that without straying into unrelated
// classes elsewhere in the bundle.
//
// Returns null if neither pattern is found near the anchor (caller must skip enrichment for that
// bundle rather than inject a selector that references an out-of-scope/undefined identifier).
const ALIAS_SEARCH_WINDOW = 3000;
function detectAlias(src) {
  const idx = src.indexOf(ANCHOR);
  if (idx === -1) return null;
  const win = src.slice(Math.max(0, idx - ALIAS_SEARCH_WINDOW), idx + ALIAS_SEARCH_WINDOW);
  let m = /([A-Za-z_$][\w$]*)\.default\.getMiniInfo\(/.exec(win);
  if (m) return m[1];
  m = /([A-Za-z_$][\w$]*)\.default\.getDName\(/.exec(win);
  if (m) return m[1];
  return null;
}

// Pure: build the caller-resolve snippet for a given contact-store alias.
function buildInject(alias) {
  return (
    'try{if(e&&e.act==="request"&&e.data){var __zcallEnrich=1;' +
    'var _u=e.data.fromId||e.data.uidN;' +
    'var _p=_u&&' + alias + '.default.getMiniInfo&&' + alias + '.default.getMiniInfo(_u);' +
    'if(_p)e._caller={name:_p.dName||_p.displayName||String(_u),avatar:_p.avatar||_p.avt||null};' +
    '}}catch(_e){}'
  );
}

// Pure: inject the caller-resolve snippet immediately before the `{type:"control",data:e}` anchor
// inside handleControl, using `alias` as the in-scope contact-store identifier for THIS bundle.
// Idempotent (MARKER guard). Fail-loud when the anchor is absent so a render layout change surfaces
// at build time instead of silently shipping uid-only incoming calls.
// `alias` defaults to auto-detection via detectAlias (falling back to 'T' if undetectable) so the
// exported function stays convenient for ad-hoc/test callers that don't want to detect first.
function applyPatch(src, alias) {
  if (src.includes(MARKER)) return src;
  if (!src.includes(ANCHOR)) throw new Error('patch-call-incoming-enrich: anchor not found');
  const a = alias || detectAlias(src) || 'T';
  return src.replace(ANCHOR, buildInject(a) + ANCHOR);
}

async function main() {
  let patched = 0;
  for (const dir of GLOB_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.js$/.test(f)) continue;
      const p = path.join(dir, f);
      let s; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (!s.includes(ANCHOR) || s.includes(MARKER)) continue;
      const alias = detectAlias(s);
      if (!alias) {
        logger.error('call-incoming-enrich: ' + f + ' has the anchor but no detectable contact-store alias — skipping enrich for this bundle');
        continue;
      }
      fs.writeFileSync(p, applyPatch(s, alias), 'utf8');
      patched++;
    }
  }
  if (patched === 0) throw new Error('patch-call-incoming-enrich: no bundle was actually enriched (anchor and/or alias undetectable everywhere)');
  logger.success('call-incoming-enrich: enriched caller name/avatar in ' + patched + ' bundle(s)');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyPatch, detectAlias, MARKER };
