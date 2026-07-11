# mp4thumb — RE evidence (symbols, pipeline, constants)

Recovered from `app/native/nativelibs/mp4thumb/darwin-x64/mp4thumb.node` (Mach-O x86_64,
node-addon-api) via a custom Mach-O parser + Capstone disassembly with stub/symbol
resolution — not guessed. Original source `../src/mp4thumb.cpp` (khatran / zalo-pc-app).

## FFmpeg identity

- `Lavc59.37.100` / `Lavf59.27.100` → **FFmpeg n5.1** (libavcodec 59.37.100, libavformat
  59.27.100). Statically baked into the mac binary (links only libc++/libSystem).
- Uses `libavformat`, `libavcodec` (h264dec/hevcdec/mjpegdec/mjpegenc), `libswscale`.
- **Protocols in the mac binary:** `cache, data, file, http, https, pipe, subfile` (TLS via
  Apple SecureTransport). The Linux build enables network + http/https/tls (openssl) for
  parity, though the app actually feeds a **local path** (verified from GUI:
  `/home/…/ZaloData/…/video/…`, maxW=maxH=300) — cloud videos are pre-downloaded, then
  thumbnailed locally.
- **Electron symbol collision (the real "Protocol not found" cause):** Electron preloads its
  own `libffmpeg.so` (RTLD_GLOBAL) exporting the same `avformat_open_input`/`av*` symbols. A
  shared/bundled ffmpeg is interposed onto Chromium's ffmpeg (no `file` protocol) → every
  call fails in the renderer. Fix: **static-link ffmpeg with `-Wl,--exclude-libs,ALL`** so
  the symbols are hidden/local (self-contained `.node`). Reproduce/verify via
  `LD_PRELOAD=…/electron/dist/libffmpeg.so node …`. Making symbols local also fixes the
  x86-asm PC32 relocations (a naive static link with exported symbols fails to link).

## Class / methods (symbols)

| Symbol | Bound |
|---|---|
| `MP4Thumb::Init` | class registration |
| `MP4Thumb::GenerateThumbnail(CallbackInfo)` | `generateThumbnail` (sync) |
| `MP4Thumb::GenerateThumbnailAsync(CallbackInfo)` | `generateThumbnailAsync` (Napi::AsyncWorker) |
| `MP4Thumb::setOutputPath(CallbackInfo)` | `setOutputPath` (unused by JS wrapper) |
| `MP4Thumb::cancel(CallbackInfo)` | `cancel` (sets atomic flag `this+0x68`) |
| ctor `MP4Thumb(CallbackInfo)` | defaults `this+0x1c`/`0x20` = **640/640** (`movabs 0x28000000280`); optional ctor(w,h) |

Helper methods: `GetDimensions`, `FindVideoStream`, `SetupDecoderContext`,
`DecodeFirstFrame`, `ScaleAndConvertFrame`, `EncodeToJPEG`, `WriteJPEGFile`, `ProcessVideo`.

## GetDimensions(info, wIdx=2, hIdx=3, &w, &h)

`w=defaultMaxW; h=defaultMaxH; if(arg[2] isNumber) w=arg[2].Uint32(); if(arg[3] isNumber) h=arg[3].Uint32();`

## ProcessVideo (the pipeline)

- `FindVideoStream`: `avformat_find_stream_info` + `av_find_best_stream(VIDEO, &codec)`.
- `SetupDecoderContext`: `avcodec_alloc_context3` + `avcodec_parameters_to_context` + `avcodec_open2`.
- `DecodeFirstFrame`: loop `av_read_frame`; skip pkts whose `stream_index != idx`;
  `avcodec_send_packet` + `avcodec_receive_frame`; return the **first** decoded frame.
  No seek, no keyframe/thumbnail filter. Cancel flag checked each iteration.
- **Resize math** (AVFrame width@0x68, height@0x6c, format@0x74):
  `if (srcW<=maxW && srcH<=maxH) keep; else scale=min(maxW/srcW,maxH/srcH),
   newW=(int)(scale*srcW), newH=(int)(scale*srcH); newW&=~1; newH&=~1;` (downscale-only, even).
- `ScaleAndConvertFrame`: `sws_getContext(srcW,srcH,srcFmt, dstW,dstH, AV_PIX_FMT_YUV420P,
  SWS_BICUBIC (flags=4), 0,0,0)` + `sws_scale`.
- `EncodeToJPEG`: `avcodec_find_encoder(AV_CODEC_ID_MJPEG=7)`; `width/height/pix_fmt=YUV420P`;
  `time_base={1,1}`; `color_range=AVCOL_RANGE_JPEG (2)`; `av_opt_set_int(priv_data,"q",3,0)`;
  `open2`; `frame->pts=0`; `send_frame`/`receive_packet`.
- `WriteJPEGFile`: `avformat_alloc_output_context2(NULL,NULL,"mjpeg",outPath)`;
  `new_stream`; fresh MJPEG enc ctx (same params + `"q"`); `open2`;
  `parameters_from_context`; `avio_open(outPath, WRITE)`; `av_dict_set("update","1")` +
  `av_dict_set("frames","1")`; `write_header`; `pkt->{stream_index=st->index, pts=dts=duration=0}`;
  `av_packet_rescale_ts(pkt,{1,1},st->time_base)`; `av_interleaved_write_frame`; `write_trailer`.

## Error strings (exact)

`"Usage: generateThumbnail(inputPath, outputPath [, maxWidth, maxHeight])"`,
`"Usage: generateThumbnailAsync(inputPath, outputPath [, maxWidth, maxHeight])"`,
`"Could not open input file: <av_strerror>"`, `"Could not allocate packet/frame"`,
`"MJPEG encoder not found"`, `"Expected output path string"` (setOutputPath),
`"Failed to generate thumbnail"`.

## Verification

`__tests__/thumbnail.test.js` compiles `gen-fixture.c` (against the pinned FFmpeg),
synthesizes a JPEG, thumbnails it, and asserts JPEG magic + fit-inside-even dimensions +
**byte-identical determinism across runs** + async + cancel + the error contract. A direct
byte-compare vs the mac binary is not possible locally (no Mac oracle).
