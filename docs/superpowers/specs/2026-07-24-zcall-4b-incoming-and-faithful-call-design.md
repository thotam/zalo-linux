# zcall 4b — Cuộc gọi đến + Đồng bộ cuộc gọi giống app gốc (Design)

**Goal:** Bổ sung **cuộc gọi ĐẾN (incoming) 1-1 audio 2 chiều** trên Linux, đồng thời **RE lại và sửa cuộc gọi ĐI (outgoing)** cho khớp app gốc (state/âm thanh/UI/call-log), dùng **asset native trích từ ZaloCall.exe** để giao diện giống 100%.

**Architecture:** Giữ mô hình đã chạy: engine ở main-process (`tools/zcall-engine/main-engine.js`) nối vào IPC loop `call-send-to-native` của app; media/crypto/audio native (`nativelibs/zsrtp`, `nativelibs/zaudio`) + JS signaling (`tools/zcall-signaling`, `tools/zcall-media`); UI là các cửa sổ overlay tự dựng (`tools/zcall-ui`) do một controller quản lý (tương đương native `ZCallUiManager`). Cuộc gọi đến tái dùng toàn bộ media/crypto (đã xác nhận **đối xứng caller/callee** ở mức disasm) — chỉ thêm signaling sequencing + UI incoming.

**Tech Stack:** Electron (main + renderer), Node.js, native N-API addons (libopus/miniaudio, libsrtp2), JS thuần cho signaling. Không thêm dependency mới.

## Global Constraints (bắt buộc, verbatim)

- **Ngôn ngữ:** tài liệu + giao tiếp tiếng Việt; giữ nguyên thuật ngữ kỹ thuật, tên lệnh/biến/đường dẫn/code/định danh bằng English.
- **Attribution:** KHÔNG `Co-Authored-By`, KHÔNG chữ ký "Generated with…"/🤖 ở bất kỳ commit/PR/issue/output nào.
- **Git:** chỉ commit/push khi được yêu cầu rõ ràng. Identity: thotam. Nhánh: `zcall/incoming-4b` (từ `main`).
- **An toàn/ToS (ràng buộc):** chỉ dùng account/máy/traffic/điện thoại CỦA CHÍNH operator; cuộc gọi là operator → điện thoại của chính operator. `sessId`/keys/relay-addresses/pcap là **secret phù du, chỉ ở local, KHÔNG commit**.
- **Bản quyền asset:** asset native (PNG/MP3) trích từ ZaloCall.exe chỉ để tái tạo giao diện cho bản port cá nhân; **không** đóng gói phân phối công khai. Vendor vào repo work-tree cục bộ; nếu sau này release cần rà lại license (ghi chú trong `tools/zcall-ui/assets/native/README.md`).
- **Chỉ audio.** Video **out of scope** (chỉ chừa kiến trúc).

---

## 1. Bối cảnh & nền tảng RE (evidence)

Đã RE (5 agent, 2026-07-24) trên `ZaloCall.exe` (PE32 Windows, Qt5) + render bundle + code hiện có. Kết luận nền tảng:

- **Keying callee = caller (disasm-confirmed).** `createAndInitSRTP` (`peer.cpp` @0x871410) khởi tạo 2 SRTP stream với **cùng key material**, không role branch, không swap. Callee dùng `srtpMasterKey = sessId[0:30]`, AES_CM_128_HMAC_SHA1_80 y hệt caller. **Không có ZRTP DH** (Commit/DHPart/Confirm không tồn tại); "InitZRTP" chỉ là đăng ký relay (185B, cùng builder, cả 2 phía làm). `sessId` nằm ngay trong config incoming (`parse455/456`: `fromId, protocol, status, sessId, zrtc_config, servers, changeZRTP`) — callee **không cần** requestcall riêng.
- **Media/crypto/audio JS đối xứng.** `MediaSession`, `ZSrtp`, `ZAudio`, `initzrtp`, `srtp-kdf`, `rtp`, `media-frame`, `srtpMasterKey`, `parseConfig`, `buildExtendData`, `OPUS_CODEC` — tất cả role-agnostic, tái dùng nguyên; callee chỉ truyền `fromId`/`ssrc` của mình.
- **Render forward incoming verbatim.** Incoming = voip ctrl event `{act:"request", act_type:"voip", data:{ts, uidN, ...caller/call params...}, inCallStatus}`; render `handleControl` tự forward `{type:"control", data:e}` qua `call-send-to-native` → engine (đang IGNORE). Không cần user action ở render. **Không có UI incoming 1-1** ở render (native `ZaloCall` vẽ) → phải tự dựng. Render lookup profile khả thi (`getProfileFriendByIdSync`/`getProfileByIdFromCache`/`DNameAndAvatar` tồn tại).
- **UI native = 2 lớp cửa sổ.** `ZCallUiManager` (router) → `ZCalleeWindow` (màn incoming ring, class RIÊNG) + `ZCallMainWindowAudio_v2` (in-call, DÙNG CHUNG caller/callee) + `ZCallMainWindowVideo_v2` (video, class riêng) + `ZCallMiniMainWindow` (PiP) + `ZDeviceSetting2` (dialog thiết bị). Video swap theo `callType` → **video cần cửa sổ riêng** (defer).
- **Asset native đã trích** (169 file, tên chuẩn qua parse Qt RCC tree) tại `scratch/zcall-native-assets/`: 129 PNG + 33 SVG + 7 MP3. Gồm `accept_audiocall.png`(192, nút xanh), `endcall.png`(192, đỏ), `mic`/`mic_off`/`speaker`/`camera`/`more`(192), `setting`/`fullscreen`/`split_solid`(72), `decor-call-wave@1/2/3x.png` (sóng đổ chuông), `zalo_logo.png`(272), và 7 sound.
- **Outgoing divergence** (đối chiếu native): xem §5.

---

## 2. Kiến trúc & component map

| Native | Bản Linux (ta) | Vai trò |
|--------|----------------|---------|
| `ZCallUiManager` | `tools/zcall-ui/call-ui.js` (controller) | Quản lý cửa sổ, swap theo callType, forward device/action, IPC `zcall-ui:action` |
| `ZCalleeWindow` | `tools/zcall-ui/incoming.html/css/js` (MỚI) | Màn cuộc gọi đến (ring + Trả lời/Từ chối + tên/avatar) |
| `ZCallMainWindowAudio_v2` | `tools/zcall-ui/call.html/css/js` (REBUILD) | Cửa sổ in-call dùng chung caller/callee, states + timer + control bar |
| `ZDeviceSetting2` | `tools/zcall-ui/devices.html/css/js` (có) | Dialog "Tình trạng thiết bị" |
| `ZAudioPlayer` | `tools/zcall-ui/sounds.js` (MỚI, renderer) | Phát mp3 theo state (ringback/connecting/ringtone/endcall/busy/disconnect) |
| signaling+state | `tools/zcall-engine/main-engine.js` (MỞ RỘNG) | Máy trạng thái caller **và** callee; emit signal + state + bubble |
| `ZCallMainWindowVideo_v2` | — (Phase 3 seam, KHÔNG code) | Video window sau này |

**Luồng chung:** render (app) ⇄ IPC `call-send-to-native` ⇄ engine (main) ⇄ `sendToRender('call-update'|'call-send-signal', cmd, data)` để render chạy HTTP signal; engine ⇄ controller (`call-ui.js`) qua object `ui` (emit state/devices, nhận action end/mute/select/accept/decline); controller ⇄ các renderer window qua IPC `zcall-ui:action` + `webContents.send`.

---

## 3. Asset native — vendoring (Phase 0)

- Copy bộ asset cần dùng từ `scratch/zcall-native-assets/` → **`tools/zcall-ui/assets/native/`** (commit vào repo work-tree): PNG control (`accept_audiocall.png`, `endcall.png`, `mic.png`, `mic_off.png`, `speaker.png`, `speaker_off.png`, `setting.png`, `close.png`, `more.png`, `accept_videocall.png` cho sau), `decor-call-wave@1/2/3x.png`, `zalo_logo.png`; 7 sound (`zalo_ringtone.mp3`, `zalo_ringback.mp3`, `connecting.mp3`, `endcall.mp3`, `busy.mp3`, `disconnect.mp3`, `oldendcall.mp3`).
- `patch-zcall-main-engine.js` copy `tools/zcall-ui/**` (gồm `assets/native/`) → `app/native/zcall-ui/` khi build (mở rộng bước copy hiện có; bỏ dần glob zalo-font khi UI chuyển hẳn sang PNG).
- Thêm `tools/zcall-ui/assets/native/README.md` ghi nguồn + ghi chú license (không phân phối công khai).
- Palette (từ RE, dùng trong CSS): Zalo blue `#0068ff` (hover `#004bb9`), nền tối `#1A1A1A`/`#0A0A0A`, hangup đỏ `#ef4e49`/`#fe5050`, timer secure xanh `#81e331`, timer warn gold `#f8d15a`, success `#00c578`, error `#ef4e49`, grey `#72808e`/`#e1e4ea`. Font: **Roboto** (tên/tiêu đề), **Segoe UI** (status/timer).

---

## 4. Sound subsystem (Phase 0)

`sounds.js` (renderer, dùng chung call + incoming window): một quản lý `<audio>` phát/loop theo state, driven bởi state event từ engine (không tự quyết). Map **định danh từ native `ZAudioPlayer` enum order (definitive)**:

| Sound | Phát khi | Loop |
|-------|----------|------|
| `connecting.mp3` | state `dialing`/`checking`/`connecting` | loop |
| `zalo_ringback.mp3` | caller state `ringing` (sau 407) | loop |
| `zalo_ringtone.mp3` | callee incoming (đang đổ chuông) | loop |
| `endcall.mp3` | kết thúc bình thường | one-shot |
| `busy.mp3` | máy bận (`onReceiverBusy`) | one-shot |
| `disconnect.mp3` | rớt mạng/lỗi media | one-shot |

Chuyển state → dừng sound cũ, phát sound mới. Loop-mode chốt live (spike §9).

---

## 5. Phase 1 — Outgoing faithfulness (sửa P1–P5)

Engine hiện chỉ emit `calling → connected → free/ended`; native: `dialing → dialSuccess → checking → callerRingRing → callerConnecting → incall → ending`. Sửa:

- **P2 — nhận 407:** thêm nhánh `recvSignal 407` trong `handleSendToNative` → `emit callState 'ringing'` + `ui.setState('ringing')` → renderer phát `zalo_ringback` + label "Đang đổ chuông". (Caller KHÔNG gửi signal đáp 407 — chỉ đổi state/sound; đã xác nhận native cũng vậy.)
- **P3 — state connecting:** `onAnswer` (status 0) không nhảy thẳng connected: emit `callState 'connecting'` + `connecting.mp3` trước, rồi mới `'connected'` (bắt đầu timer) khi media thực sự lên (media đầu tiên nhận được, hoặc sau ngưỡng ngắn). Timer duration chỉ chạy từ `connected`.
- **P4 — no-answer timeout:** đặt timer khi bắt đầu ring; hết hạn (giá trị đo live, ~30–60s) → gửi **405 cancel** + `teardown` với reason "no answer" → call-log nhỡ. Hủy timer khi answer/reject/cancel.
- **P1 — sounds:** gắn sound player theo state ở trên (ringback/connecting) + kết thúc (endcall/busy/disconnect theo outcome).
- **P5 — reason mapping:** **giữ SUSPECTED tới khi verify live.** Native: busy là signal riêng (`onReceiverBusy`), reject + `callee_init_zrtp_fail` mới là answer status. Tạm giữ `ANSWER_STATUS_REASON` hiện có, thêm xử lý busy-qua-signal-riêng nếu live capture xác nhận; dọn 5/6 khi rõ.
- **P6 — GIỮ NGUYÊN:** mic bật trong ringing khớp native (`startAudioInRingring`) — KHÔNG sửa.
- **UI rebuild call window** (`call.html/css/js`): thay zalo-font glyph → PNG native (`mic`/`mic_off`, `speaker`/`speaker_off`, `endcall` đỏ, `setting`); nền `#1A1A1A`; name Roboto 19px/600 trắng; status pill `#statusWidget` `rgba(0,0,0,.39)` radius 5; **timer đổi màu** trắng→`#f8d15a`(kém)→`#81e331`(secure); control bar order `[Mic][Speaker][End center][Setting]`; states dialing/ringing/connecting/incall/ending. Label cập nhật trong `call-format.js` (`ringing`→"Đang đổ chuông", `connecting`→"Đang kết nối", giữ `calling`/`ended`; wording chốt live).

Không đụng P7/P8 (gcc tuning, relay retry) — optional, để SP sau.

---

## 6. Phase 2 — Incoming calls (4b, cốt lõi)

### 6.1 Engine (main-engine.js)
- **Entry point mới:** `handleSendToNative` nhận `m.type==='control' && m.data.act==='request'` → `startIncoming(m.data)`.
- **`startIncoming(ctrl)`:** parse config incoming (`data.data`: `fromId`=caller uid, `toId`=uid mình, `callId`, `sessId`, `servers`, `codec`; caller name/avatar từ `_caller` do render patch đính — fallback uid). Nếu `inCallStatus==='zalo'` (đang bận) → **auto-decline** emit `402 status=1` (busy), dừng. Ngược lại: set `current` = cuộc gọi đến; emit **407** `sendRingRingCall(callerId, callId)`; `ui.showIncoming(caller)`; `callState 'ringing-incoming'` (callRunning=true); renderer phát `zalo_ringtone` loop.
- **`acceptIncoming()`** (từ `ui.on('accept')`): `setupMedia(current, cfg)` với `ssrc = uid mình`, `toId = caller` (mở relay + MediaSession + ZAudio + p2p/extendData như caller); emit **402** `sendAnswerCall(callerId, callId, status=0, OPUS_CODEC, extendData, rtcp, rtp, session=sessId)`; đóng incoming window; `ui.show(callWin)` state `'connected'`; `callState 'connected'`; audio 2 chiều.
- **`declineIncoming()`** (từ `ui.on('decline')`): emit **402 status=3** (reject); `teardown(callId, reason, role=0)`.
- **Remote cancel/timeout khi đang đổ chuông:** `control cancel`/`end_call`/`recvSignal 409` → `teardown` + đóng incoming window (nhánh teardown hiện có, thêm đóng incomingWin).
- **408 answerack từ caller:** xác nhận connected (media đã chảy) — no-op ngoài log.
- **`teardown` thêm tham số `role`:** call-log **role:0** cho incoming (answered→cuộc gọi đến + duration; declined/missed→nhật ký tương ứng; action `recommened.receivecall` vs `recommened.misscall`).

### 6.2 Incoming window (`incoming.html/css/js` — MỚI, ≈ ZCalleeWindow)
- Layout: avatar lớn + tên caller (từ `_caller`), `decor-call-wave` animation quanh avatar, sub-label "Cuộc gọi thoại đến"; 2 nút tròn 192-scaled: **Trả lời** (`accept_audiocall.png` nền xanh) → action `'accept'`, **Từ chối** (`endcall.png` nền đỏ) → action `'decline'`; nút setting mở device dialog (tùy chọn). Titlebar tối, close = decline.
- `preload.js` chung; action gửi qua `zcall-ui:action` (`{op:'accept'|'decline'|'devwin'|...}`).
- Phát `zalo_ringtone` loop khi mở, stop khi accept/decline/close.

### 6.3 Controller (`call-ui.js`)
- Thêm `incomingWin` (song song `win`/`devWin`). `showIncoming(caller)` mở `incoming.html`, forward device nếu mở settings. `onAction` route `'accept'`/`'decline'` → emit `ui` events; window controls. Accept → đóng incomingWin, `win.show()` connected (hand-off). Giữ listener sống suốt đời controller (bài học 4a).

### 6.4 Render patch (`patch-call-incoming-enrich.js` — MỚI)
- Anchor tại block `isIncomingCallEvent(e)` trong `handleControl`, chèn resolve `_caller={name,avatar}` từ contact store (`getProfileFriendByIdSync`/`getProfileByIdFromCache`) theo caller uid, đính vào event trước `_sendToNative`. Idempotent + fail-loud (anchor bắt buộc). Resolve fail → bỏ qua (engine fallback uid). Wire vào `scripts/main.js`.

---

## 7. Phase 3 — Sẵn sàng video (KHÔNG code)

- `call-ui.js` thiết kế để **swap window theo `callType`** (như `ZCallUiManager`): audio window hôm nay; chừa chỗ `videoWin` sau. Giữ asset `accept_videocall.png` + camera icon. Incoming window để sẵn nút accept-video (ẩn ở Phase 2).
- Ghi chú scope video (SP tương lai): V4L2 capture + VP8/H264 (webrtc video coding) + video RTP/RTCP + A/V sync + GL/`<video>` render + luồng `switchToVideoCall`. **Không** thuộc 4b.

---

## 8. State machine (tham chiếu)

**Caller** (`main-engine.js` emit `callState`): `free → calling(dialing) → ringing(407) → connecting(answer 0) → connected(media) → ended`. Sound: ringback(ringing), connecting(connecting), stop(connected), endcall/busy/disconnect(ended theo outcome).

**Callee**: `free → ringing-incoming(control request, 407 sent) → [accept] connecting(402 sent) → connected(media) → ended | [decline] ended(402 status=3) | [busy] ended(402 status=1)`. Sound: ringtone(ringing-incoming), connecting, stop(connected), endcall(ended).

**Signal reference:** 401 requestcall, 416 request(extendData), 407 ringring(caller nhận / callee gửi), 402 answer(callee gửi status; caller nhận), 408 answerack(caller gửi), 405 cancel, 409 endcall, 406 logendcall. Answer status: 0=accept, 1=busy, 3=reject, 5=zrtp-fail, 6=timeout (native semantics — busy có thể qua signal riêng, verify live).

---

## 9. Spikes (verify live — không block, chốt lúc code)

1. Field names chính xác trong `data.data` incoming (1 live capture qua `[CALLDIAG-PAYLOAD]` với 1 cuộc gọi đến).
2. P5 busy: busy đến qua signal riêng (`onReceiverBusy`) hay answer status 1.
3. Giá trị timeout no-answer (P4).
4. uid mình cho ssrc: `cfg.toId` hay cần inject `userId` từ render.
5. Text state Vietnamese chính xác (verify app đang chạy).
6. Per-state sound index + loop-mode (gần như chắc từ enum order, xác nhận live).
7. Selector profile chính xác + scope gọi trong `CallController` cho render patch.

---

## 10. Testing

- **TDD offline** (như outgoing): unit test engine với `FakeSession`/`FakeAudio`/fake `ui` + payload `control request` giả. Case: `startIncoming`, `accept` (setupMedia + 402 status=0 + connected), `decline` (402 status=3 + teardown role:0), `busy` (inCallStatus → 402 status=1), `remote-cancel` (đóng incoming), caller `407→ringing`, `connecting→connected`, no-answer `timeout→405+missed`. `setupMedia` factor có test riêng. `sounds.js`/`call-format.js` test thuần.
- Patch test: `patch-call-incoming-enrich` (anchor idempotent + fail-loud + injected JS valid), mở rộng test `patch-zcall-main-engine` cho copy asset.
- **Live validate:** điện thoại gọi Linux → hiện incoming window + ringtone → Trả lời → audio 2 chiều → kết thúc; + outgoing: đổ chuông có ringback + state ringing/connecting + sounds + timeout no-answer + call-log đúng outcome.

---

## 11. Out of scope

- Video call (chỉ chừa kiến trúc §7).
- Group call.
- gcc tuning / relay retry robustness (P7/P8).
- Xóa patch diagnostics (`patch-call-diagnostics`, `patch-call-trace`) + engine zlog-to-file: giữ để debug 4b, **gỡ trước release** (task riêng cuối).

---

## 12. File structure (tạo/sửa)

**Tạo:** `tools/zcall-ui/incoming.html`, `incoming.css`, `incoming.js`; `tools/zcall-ui/sounds.js`; `tools/zcall-ui/assets/native/**` (PNG+MP3+README); `scripts/patches/patch-call-incoming-enrich.js`; test tương ứng dưới `tools/zcall-*/__tests__/`.

**Sửa:** `tools/zcall-engine/main-engine.js` (setupMedia factor; 407/connecting/timeout; startIncoming/acceptIncoming/declineIncoming; teardown role); `tools/zcall-ui/call-ui.js` (incomingWin + showIncoming + accept/decline route); `tools/zcall-ui/call.html/css/js` (rebuild bằng PNG native + states/colors/timer); `tools/zcall-ui/call-format.js` (labels ringing/connecting); `scripts/patches/patch-zcall-main-engine.js` (copy assets/native); `scripts/main.js` (wire patch mới).
