# v8-profiles (native, Linux)

Native CPU profiler for Zalo's `native/nativelibs/v8-profiles`, built from source for
Linux x64 against the Electron 22.3.x ABI (raw V8 `CpuProfiler`, via NAN — not N-API,
so it must be rebuilt per Electron version).

Exposes the exact `binding.cpu.{ startProfiling, stopProfiling, setSamplingInterval,
profiles }` shape and the head-based CpuProfile format Zalo's `index.js` wrapper
expects (`{typeId,uid,title,head,startTime,endTime,samples,timestamps}`; node
`{functionName,url,scriptId,lineNumber,callUID,bailoutReason,hitCount,children}`).

Vendored from **v8-profiler-next** (MIT — see `LICENSE-v8-profiler-next`), trimmed so
the legacy (type 0) node serialization matches Zalo's field set byte-for-byte
(dropped `columnNumber`/`id`/`lineTicks`; `callUID` uses `GetNodeId()` since
`GetCallUid()` was removed in V8 8).
