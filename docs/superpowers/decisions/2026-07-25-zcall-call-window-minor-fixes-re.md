# zcall — RE ZaloCall.exe cho 3 Minor của call window (speaker mute / end sounds / double-answer)

Ngày: 2026-07-25. Binary RE: `ZaloCall.exe` (PE32 i386, Zalo Desktop Windows 26.6.11,
`~/Downloads/ZaloSetup-26.6.11/$PLUGINSDIR/app-32/Zalo-26.6.11/plugins/capture/ZaloCall.exe`).
Dump: `scratch/zcall-re-win/{strings.txt,text.asm}` (objdump -M intel). imagebase 0x400000.

Mục tiêu: 3 Minor (từ `.superpowers/sdd/progress.md` FINAL review) — làm cho giống native.

## #1 Nút loa = mute OUTPUT (playout), không phải chọn device / không cosmetic

Bằng chứng:
- Nút loa UI: `audBtnVolumeClick`, `_speakerStatus`, icon `speaker.png`/`speaker_off.png`/`speaker_off_solid.png`.
- Hàm proxy cross-thread "PW" (0x7cd4b0–0x7cdc90): `PW setSpeakerOn, %d` (0x7cdb10) và
  `PW, muteSpeaker, %d` (0x7cdc30). Mỗi hàm chỉ log + post 1 task async (`0x418c82`) vào engine
  thread để áp trạng thái (callback 0x41e4d4 / 0x429573). Có cả `updatePlayoutDeviceVolume(int)`.
- ⇒ Nút loa gọi `muteSpeaker(bool)` → engine tắt/bật OUTPUT/playout audio thật.

Triển khai Linux (ZAudio native KHÔNG có API mute output): gate `audio.play(inbound)` khi
`c.speakerMuted`. Media vẫn tới (inCount++) nhưng không phát ra loa — hiệu ứng tương đương.
Wiring: `ui.on('toggleSpeaker', v => current.speakerMuted = !!v)` +
`session.on('media', m => { inCount++; if (c.speakerMuted) return; audio.play(m.payload); })`.

## #2 End sounds: busy.mp3 / disconnect.mp3 / endcall.mp3

Bộ sound (qrc, preload tại 0x77bd..–0x77c0.., thứ tự index):
`connecting(0) ringback(1) ringtone(2) endcall(3) busy(4) disconnect(5) oldendcall(6)`.

Trigger (string evidence):
- **busy.mp3** ← `ui:onReceiverBusy` (0x793070) / "The receiver is busy" / "call busy" — người nhận bận.
- **disconnect.mp3** ← `partnerDisconnect %d` (0x7a78e0) / "Zalo is reconnecting." — đang trong cuộc thì
  đối phương rớt (media drop mid-call).
- **endcall.mp3** ← kết thúc thường (gác máy hai phía / cancel / reject / missed). (`oldendcall.mp3` = bản cũ, bỏ qua.)

Triển khai Linux: map `control answer status` → outcome cho `sounds.apply('ended', outcome)`:
- status 1 (busy) → `'busy'` → busy.mp3.
- còn lại → default → endcall.mp3.
- **disconnect KHÔNG wire**: cần phát hiện media-drop giữa cuộc (không có tín hiệu tin cậy ở bản Linux
  hiện tại) → luôn dùng endcall.mp3 cho mọi kết thúc còn lại. Ghi rõ để sau bổ sung nếu thêm detect drop.

## #5 Answer trùng → no-op (guard theo state)

Native có state machine (`PW setCallState, %d` 0x7cd4c0 → post state vào engine; các log
`updateIncallState`, `onCallState: %d`, `,"endCallState":%d`). `answer` chỉ hợp lệ từ trạng thái đang
đổ chuông; khi đã in-call, một `control answer` trùng bị bỏ qua (transition không hợp lệ).

Triển khai Linux: đầu `onAnswer()`, nếu `c.answered` đã true → return (bỏ qua). Tránh phát lại 408 +
mồ côi `c._connTimer` / thêm đường media thừa khi có `control answer status:0` lặp.

## Kết quả
Sửa trong `tools/zcall-engine/main-engine.js` (speakerMuted gate + ui.on toggleSpeaker;
ANSWER_STATUS_OUTCOME + teardown(outcome) → ui.setState('ended',{outcome}); onAnswer duplicate guard).
Test bổ sung trong `__tests__/main-engine.test.js` (speaker-mute + dup-answer block; busy-status mở rộng
assert outcome 'busy'). Toàn bộ zcall + patch tests EXIT 0. Rebuild `.deb` OK.
