# Kế hoạch RE `v8-profiles` — build NATIVE cho Linux (không dùng JS)

Branch: `re/v8-profiles`. Mục tiêu: dựng **native addon C++** cho Linux x64 xuất đúng API `binding.cpu.*` mà `index.js` của Zalo mong đợi, build từ source qua node-gyp theo Electron 22.3.27 — **không** reimplement bằng JS.

---

## 0. Phát hiện nền tảng (từ RE recon)

- Binary gốc `profiler_electron1.8_mac.node`: **NODE_MODULE cũ** (`_node_module_register`, dùng **NAN** + `v8::Isolate::GetCpuProfiler()` — API bị xoá từ V8 5.4, thời **Electron 1.8 / V8 5.x**). ⇒ **Không load được trong Electron 22** (V8 10.x, NODE_MODULE_VERSION khác). Kết luận: profiler **đã chết cả trên macOS/Windows** ở bản 26.6.11 hiện tại — Zalo ship binary stale. Bản Linux native ta dựng sẽ là bản **đầu tiên thực sự chạy**.
- Vì không phải N-API (V8 CpuProfiler nằm ngoài N-API), addon **buộc phải rebuild theo từng phiên bản Electron** (giống bản gốc). Build qua `node-gyp --target=<electron> --dist-url=headers` — đúng recipe `builder.js` sẵn có.
- **Contract cần khớp** (từ literal trong binary + `index.js`):
  - Export: `{ cpu: { startProfiling(name, recsamples), stopProfiling(name) → profile, setSamplingInterval(int), profiles } }`.
  - `profile` (head-based, kiểu RisingStack v8-profiler): `{ typeId:"CPU", uid, title, head, startTime, endTime, samples, timestamps }`.
  - `head`/mỗi node: `{ functionName, url, scriptId, lineNumber, callUID, bailoutReason, hitCount, children:[…] }`.
  - `profile.delete()` (giải phóng `v8::CpuProfile`).
  - `cpu.profiles` (map/collection profile đang giữ).
  - `index.js` wrapper đọc `profile.startTime/endTime`, gán `__proto__`, gọi `profiles[k].delete()`.

## 1. Quyết định thiết kế

- **Cơ chế:** NAN (Native Abstractions for Node) + **`v8::CpuProfiler` hiện đại** (`v8::CpuProfiler::New(isolate)`, `StartProfiling`, `StopProfiling`). NAN để mượt hoá khác biệt V8 giữa các Electron.
- **Base source:** tham chiếu **`v8-profiler-next`** (MIT, `1.10.0`) — đã chứng minh build được trên Node/Electron hiện đại và sinh đúng head-based CpuProfile. Hai lựa chọn:
  1. **Vendor + thu gọn** phần CPU của `v8-profiler-next`, thêm lớp `cpu` namespace + `.delete()` cho khớp shape Zalo. *(khuyến nghị — ít rủi ro API V8)*
  2. **Clean-room ~250 dòng** NAN thuần (skeleton ở Task 3). Sát bản gốc, kiểm soát hoàn toàn, nhưng phải tự lo khác biệt API V8.
- Build một biến thể duy nhất: `profiler_electron_linux_x64.node` (x64, Electron 22.3.27).
- **Không** thêm runtime dep (V8 nằm sẵn trong Electron). Build dep: `nan` (npm).

## 2. Layout & tích hợp (theo convention dự án)

```
nativelibs/v8-profiles/
  binding.gyp          # target v8-profiles-native, include nan, C++17
  package.json         # dep: nan
  src/v8-profiles.cc   # addon: cpu.{start/stop/setInterval/profiles} + serialize + delete
scripts/patches/patch-v8-profiles.js   # build + đặt .node + splice index.js nhánh linux (fail-loud)
```
- Wire vào `scripts/main.js` orchestrator: chạy `patch-v8-profiles` **trước** `patch-linux-guards`.
- `patch-linux-guards`: giữ nguyên nhánh stub v8-profiles làm **fallback an toàn** (nếu .node lỗi load thì vẫn không crash). patch-v8-profiles chèn nhánh `linux` require .node THẬT vào trong `try` trước khi tới nhánh mac.

---

## 3. Task list (bite-sized, TDD-style)

### Task 1 — Vendored source: binding.gyp + package.json
- `nativelibs/v8-profiles/package.json`: `{ "name":"v8-profiles-linux","private":true,"dependencies":{"nan":"^2.18.0"} }`.
- `nativelibs/v8-profiles/binding.gyp`:
  ```gyp
  { "targets": [{
    "target_name": "v8-profiles-native",
    "sources": ["src/v8-profiles.cc"],
    "include_dirs": ["<!(node -p \"require('nan').include\")"],
    "cflags_cc": ["-std=c++17","-O2"],
    "cflags_cc!": ["-fno-exceptions"]
  }]}
  ```
- Verify: `node -p "require('nan').include"` ra path; `node --check` không áp dụng cho gyp — chỉ cần file tồn tại.

### Task 2 — C++ addon skeleton (khởi tạo cpu object + register)
- `src/v8-profiles.cc` khung: include `<nan.h>`, `<v8-profiler.h>`; static `v8::CpuProfiler* g_cpuProfiler=nullptr`; `NAN_MODULE_INIT(Init)` tạo object `cpu` với 4 method + set `exports->Set("cpu", cpuObj)`; `NODE_MODULE(v8_profiles_native, Init)`.
- Verify: build rỗng (chưa method) load được: `require('build/Release/v8-profiles-native.node').cpu` là object.

### Task 3 — startProfiling / setSamplingInterval / profiles
```cpp
NAN_METHOD(StartProfiling){
  v8::Isolate* iso = info.GetIsolate();
  if(!g_cpuProfiler){ g_cpuProfiler = v8::CpuProfiler::New(iso); }
  Nan::Utf8String title(info[0]);
  bool rec = info.Length()>1 ? Nan::To<bool>(info[1]).FromMaybe(true) : true;
  g_cpuProfiler->StartProfiling(Nan::New(*title?*title:"").ToLocalChecked(), rec);
}
NAN_METHOD(SetSamplingInterval){
  if(!g_cpuProfiler) g_cpuProfiler = v8::CpuProfiler::New(info.GetIsolate());
  g_cpuProfiler->SetSamplingInterval(Nan::To<int>(info[0]).FromMaybe(1000));
}
// profiles: object rỗng (Zalo chỉ enumerate + delete) — giữ 1 Persistent map nếu cần .delete() theo key
```
- Verify: `cpu.startProfiling("t")` không throw; `cpu.setSamplingInterval(100)` ok.

### Task 4 — stopProfiling + serialize head-based + delete
- `StopProfiling(name)` → `v8::CpuProfile* p = g_cpuProfiler->StopProfiling(title)`; dựng object:
  - `typeId:"CPU"`, `uid`(tăng dần), `title`, `startTime:p->GetStartTime()`, `endTime:p->GetEndTime()` (micro giây, giữ nguyên như RisingStack), `head:SerializeNode(p->GetTopDownRoot())`, `samples:[nodeId…]` (`p->GetSamplesCount()`, `p->GetSample(i)->GetNodeId()`), `timestamps:[p->GetSampleTimestamp(i)…]`.
  - Gắn method `delete` = C++ callback gọi `p->Delete()` (giữ `p` trong `External`/Persistent).
- `SerializeNode(const v8::CpuProfileNode* n)` đệ quy → `{ functionName:n->GetFunctionName(), url:n->GetScriptResourceName(), scriptId:n->GetScriptId(), lineNumber:n->GetLineNumber(), callUID:n->GetCallUid?/id, bailoutReason:n->GetBailoutReason(), hitCount:n->GetHitCount(), children:[…] }`.
- Verify (Task chính): chạy workload rồi `const pr = cpu.stopProfiling("t")` → assert `pr.head.functionName` tồn tại, `pr.endTime>pr.startTime`, `Array.isArray(pr.samples)`, `typeof pr.delete==='function'`; gọi `pr.delete()` không crash.

### Task 5 — patch-v8-profiles.js
- Build qua `builder.js` → copy `.node` → `app/native/nativelibs/v8-profiles/profiler_electron_linux_x64.node`.
- Splice `index.js`: chèn nhánh linux vào biểu thức `binding = …` (fail-loud regex, idempotent):
  ```
  process.platform === 'win32' ? (...win...)
    : process.platform === 'linux' ? require('./profiler_electron_linux_x64.node')
    : require('./profiler_electron1.8_mac.node')
  ```
  (chèn nhánh linux trước nhánh mac; giữ try/catch của linux-guards làm fallback).
- Post-condition: load lại index.js, `require(index.js).startProfiling` là function, round-trip start→stop trả profile có `head`.
- Verify: `node scripts/patches/patch-v8-profiles.js` xanh; grep index.js có `profiler_electron_linux_x64.node`.

### Task 6 — Wire orchestrator + guard fallback
- `scripts/main.js`: thêm `patch-v8-profiles` vào chuỗi (trước `patch-linux-guards`).
- Xác nhận `patch-linux-guards` v8-profiles guard vẫn là fallback (không phá nhánh linux vừa chèn) — cập nhật marker để 2 patch không đá nhau.
- Verify: `SETUP` chạy trọn, index.js có cả nhánh linux (require .node thật) lẫn try/catch fallback.

### Task 7 — Verify runtime dưới Electron 22 (xvfb) + package + CI
- Smoke: chạy `xvfb-run electron -e "const p=require('app/.../v8-profiles'); p.startProfiling('x'); heavyLoop(); const pr=p.stopProfiling('x'); assert(pr.head); pr.delete && p.deleteAllProfiles();"` → PASS.
- `.deb`: `.node` nằm trong `asarUnpack`, không cần runtime dep mới. CI: `nan` cài qua `npm install` trong lib; không cần apt thêm.
- Full smoke boot vẫn `SMOKE_OK`.

---

## 4. Rủi ro & lưu ý
- **API V8 đổi giữa các Electron**: `StartProfiling` từng có overload `(Local<String>, bool)` và `(Local<String>, CpuProfilingOptions)`. Với V8 của Electron 22, dùng overload đúng (NAN + `v8-profiler-next` đã xử lý) — verify lúc compile.
- **Không N-API** ⇒ phải rebuild khi bump Electron. `builder.js --target` lo việc này; ghi rõ trong PORTING-GUIDE.
- **Shape chỉ cần "đủ dùng"**: app dùng profiler cực thưa (đường diagnostic), nên miễn `stopProfiling` trả object head-based hợp lệ + `delete()` chạy là đạt. Không cần khớp byte-for-byte binary gốc (vốn đã chết).
- **Giá trị thực tế thấp**: đây là tính năng chẩn đoán, không phải UX. Làm cho "hoàn hảo/đủ bộ", không phải để người dùng thấy. Ưu tiên vẫn dưới zjxl/zimage.

## 5. Định nghĩa "hoàn thành"
`SETUP` build ra `profiler_electron_linux_x64.node` (ELF), `index.js` nhánh linux require nó; dưới Electron 22 chạy start→(workload)→stop trả CpuProfile head-based hợp lệ, `delete()` ok; smoke boot `SMOKE_OK`; `.deb` chứa `.node`; đồng thời **fallback stub** vẫn giữ để không bao giờ crash nếu binary lỗi.
