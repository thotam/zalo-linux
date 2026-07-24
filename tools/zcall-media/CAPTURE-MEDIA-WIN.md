# SP2 2a — Windows media capture runbook

Own call only (your account → your own phone). Media + sessId stay local; commit only redacted.

## 1. Capture the SRTP media
- Wireshark/Npcap: capture filter `udp port 4200` (the media relay port).
- Place a real 1-1 audio call to your own phone; let it connect ~10s; hang up.
- In Wireshark, pick a few UDP packets to `<relay>:4200` that carry media (larger, steady-rate).
  For each: right-click the UDP payload Data -> Copy -> ...as Hex Stream. Collect into a JSON
  array file `media.json` = ["<hex1>","<hex2>", ...].

## 2. Capture that call's sessId (same call)
- Run the step-1 tooling on Windows to fetch the sessId of the call:
      node tools/zcall-signaling/prototype.js <yourCalleeId>
  (or read the sessId from the requestcall response you decrypt). NB the sessId is per-call and
  ephemeral — use the one from the SAME call whose media you captured.

## 3. Decrypt
      node tools/zcall-media/decrypt-capture.js <sessId> media.json
- Success = packets report `authOk: true` (HMAC-SHA1 verified with sessId[0:30]) and `pt`/opus.
  That proves sessId[0:30] is the real SRTP key and pins the tag length (10 vs 4).

Send the (redacted) authOk/pt/tagLen result — never the raw sessId or media.
