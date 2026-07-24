# Hướng dẫn capture cuộc gọi Zalo trên Windows (SP2.1) — chi tiết

Mục tiêu: bắt được **cách Zalo trao/khởi tạo khoá mã hoá cuộc gọi (keying)** khi bạn gọi thật,
để kết luận **có thể tái tạo engine gọi trên Linux hay không** (GO/NO-GO).

> **Ranh giới:** chỉ máy / tài khoản / traffic **của chính bạn**. Gọi **tài khoản bạn → điện
> thoại của bạn**. Không đụng traffic người khác. Dữ liệu bắt được giữ **local**; chỉ commit
> bản đã che (redact).

Bạn không cần rành Wireshark — làm theo đúng từng bước dưới đây.

---

## 0. Cần cài trước

1. **Zalo PC bản Windows** — cài + đăng nhập bằng **tài khoản của bạn**.
2. **Wireshark** — tải ở https://www.wireshark.org/download.html → khi cài **nhớ tick cài Npcap**.
3. **Node.js** (để chạy công cụ phân tích) — https://nodejs.org (bản LTS). *Nếu ngại cài Node
   trên Windows, bạn có thể copy file kết quả về máy Linux rồi chạy công cụ ở đó — xem Mục 6.*
4. `git pull` repo này về máy Windows (bạn đã có kế hoạch này).

Chuẩn bị sẵn: **điện thoại của bạn** (cùng tài khoản Zalo hoặc tài khoản thứ 2) để gọi tới.

---

## Cách A — Wireshark + TLS keylog (KHUYẾN NGHỊ, thử đầu tiên)

Ý tưởng: bảo Chromium (Zalo là Electron) ghi lại "chìa khoá TLS" ra 1 file, rồi Wireshark dùng
file đó **giải mã HTTPS** của chính máy bạn → đọc được nội dung `call_config` / `requestcall`.

### A1. Bật keylog rồi mở Zalo *từ cùng cửa sổ dòng lệnh*
Mở **Command Prompt (cmd)**, chạy đúng 2 dòng (sửa đường dẫn Zalo nếu khác):

```cmd
set SSLKEYLOGFILE=%USERPROFILE%\zalo-tls-keys.log
"%LOCALAPPDATA%\Programs\Zalo\Zalo.exe"
```

> Nếu không thấy Zalo.exe ở đó: bấm chuột phải shortcut Zalo → *Open file location* để biết
> đường dẫn, rồi thay vào dòng thứ 2. **Quan trọng:** phải mở Zalo từ cmd đã `set` biến ở trên,
> nếu mở bằng icon thì keylog không ghi.

Kiểm tra: sau ~30s, file `C:\Users\<ban>\zalo-tls-keys.log` phải **có nội dung** (mở bằng
Notepad thấy các dòng `CLIENT_HANDSHAKE_TRAFFIC_SECRET ...`). Nếu file **trống** → keylog không
ăn (native engine dùng TLS riêng) → chuyển sang **Cách B** hoặc **C**.

### A2. Trỏ Wireshark tới keylog
Wireshark → menu **Edit → Preferences → Protocols → TLS** → ô **(Pre)-Master-Secret log
filename** → chọn `C:\Users\<ban>\zalo-tls-keys.log` → OK.

### A3. Bắt gói
1. Ở màn hình chính Wireshark, double-click card mạng đang dùng (thường **Wi-Fi** hoặc
   **Ethernet**) để bắt đầu capture.
2. Trên ô filter gõ: `tls or udp` rồi Enter.
3. **Thực hiện cuộc gọi:** trong Zalo, mở chat 1-1 với **chính bạn (điện thoại)**, bấm gọi
   **audio**, để đổ chuông/kết nối **~20 giây**, rồi cúp.
4. Bấm nút **đỏ (stop)** trên Wireshark để dừng.

### A4. Tìm phần signaling cuộc gọi
Trên ô filter, thử lần lượt các bộ lọc sau (Enter mỗi lần):

```
http2.header.value contains "voicecall"
```
hoặc
```
frame contains "call_config"
```
hoặc
```
frame contains "voicecall"
```

- Nếu ra **dòng có nội dung đọc được** (đã giải mã) → chuột phải một dòng → **Follow → HTTP/2
  Stream** (hoặc HTTP Stream) → copy toàn bộ phần **JSON response** → dán vào 1 file, lưu tên
  `signaling.json` (bọc trong dấu `[ ]` nếu có nhiều đoạn, ngăn cách bằng dấu phẩy).
- Nếu vẫn thấy chữ mã hoá (không đọc được) dù keylog có nội dung → traffic cuộc gọi đi ngoài
  Chromium → sang **Cách C (mitmproxy)** hoặc dùng **Cách B (UDP)**.

➡️ Có `signaling.json` rồi thì nhảy tới **Mục 6 (Phân tích)**.

---

## Cách B — Bắt gói UDP (LUÔN có dữ liệu, kể cả khi không giải mã được)

Cuộc gọi truyền âm thanh qua **UDP** (ZRTP/RTP). Dù không giải mã được nội dung media, phần
**gói handshake điều khiển** vẫn lộ **cấu trúc** — cho biết Zalo trao khoá kiểu chuẩn (DH/nonce
→ có thể tái tạo) hay kiểu đóng kín (server-attested → không tái tạo được).

1. Wireshark → bắt gói (như A3), filter: `udp`.
2. Gọi audio ~20s như trên, rồi stop.
3. Trong lúc gọi sẽ có **luồng UDP lưu lượng lớn** tới vài IP server. Chuột phải một gói UDP
   đầu luồng đó → **Follow → UDP Stream** để xem, hoặc:
4. Lưu vài gói ĐẦU của luồng (những gói nhỏ trước khi có media lớn — đó là handshake):
   chọn gói → panel giữa, chuột phải mục **Data** → **Copy → …as Hex Stream**.
5. Dán hex đó vào file `zrtp-hex.txt`, rồi phân tích:

```cmd
node tools/zcall-re/parse-zrtppacket.js zrtp-hex.txt
```

Gửi tôi output đó — tôi đối chiếu với cấu trúc đã reverse ở SP1 (Appendix C).

---

## Cách C — mitmproxy (nâng cao, khi Cách A không giải mã được HTTPS)

1. Cài mitmproxy (https://mitmproxy.org). Chạy `mitmweb`.
2. Đặt **proxy hệ thống Windows** trỏ tới `127.0.0.1:8080` (Settings → Network & Internet →
   Proxy → Manual).
3. Mở trình duyệt vào `http://mitm.it` → tải + cài **root certificate cho Windows** (theo
   hướng dẫn trên trang đó) — đây là CA **của chính bạn**.
4. Mở Zalo, gọi audio ~20s.
5. Trong mitmweb, tìm request tới `voicecall` / `call_config` / `requestcall` → copy JSON
   response body → lưu `signaling.json`.

> Nếu Zalo **không kết nối được** khi bật proxy (chỉ lỗi khi có proxy) → app **ghim chứng chỉ
> (cert pinning)** → Cách C bị chặn. Đây là **thông tin quan trọng, hãy báo tôi** — nó nghiêng
> về kết luận keying đóng kín. Chuyển sang **Cách B**.

Nhớ tắt proxy hệ thống sau khi xong.

---

## Mục 6 — Phân tích + che dữ liệu nhạy cảm

Chạy trên Windows (có Node) **hoặc** copy `signaling.json` về máy Linux rồi chạy:

```bash
node tools/zcall-re/classify-keying.js --json signaling.json
```
Kết quả `{"klass": "..."}`:
- **`a`** = server gửi thẳng khoá SRTP → **GO**
- **`b`** = có nonce, client tự sinh khoá → **GO-ish**
- **`d`** = chỉ có session/token → khoá nằm trong handshake UDP → xem Cách B để biết `c` hay không
- **`c`** (ghi tay nếu handshake UDP là khối đóng kín / có pinning) → **NO-GO**

Tạo bản đã che để gửi/commit (không lộ khoá/id thật):

```bash
node -e "const u=require('./tools/zcall-re/capture-utils');const fs=require('fs');console.log(JSON.stringify(JSON.parse(fs.readFileSync('signaling.json','utf8')).map(u.redactSecrets),null,2))" > tools/zcall-re/sample-win-redacted.json
```

---

## Mục 7 — Gửi tôi những gì

1. **Cách nào bắt được dữ liệu?** (A keylog / B UDP / C mitmproxy — và mitmproxy có bị pinning không)
2. Output `classify-keying.js`.
3. Nếu giải mã được signaling: trong đó **có trường nào tên** `key` / `salt` / `srtpKey` /
   `nonce` / `seed` / `zrtc_config` không? (dán bản `sample-win-redacted.json`).
4. Nếu chỉ có UDP: output `parse-zrtppacket.js`.

Từ đó tôi viết **verdict cuối cùng** (GO → mở đường RE `zcall_x64.node` + reimplement Linux;
NO-GO → chốt, cứu person-year). Kẹt bước nào cứ chụp màn hình hỏi tôi.
