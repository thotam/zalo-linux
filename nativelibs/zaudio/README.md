# zaudio — opus + miniaudio N-API addon (SP2 3)

Full-duplex audio for the Linux zcall engine: opus 16 kHz mono 20 ms, mic/speaker via miniaudio
(dlopen ALSA/Pulse/PipeWire). Static libopus; miniaudio vendored (git-ignored).

## Build (local Node)
```
cd nativelibs/zaudio
npm install --ignore-scripts
npm run build:deps      # libopus static + fetch miniaudio.h
npm run build           # -> build/Release/zaudio.node
node __tests__/opus-roundtrip.test.js
```

## API
```
new ZAudio({ sampleRate=16000, channels=1, frameMs=20, bitrate=24000 })
  .encodeFrame(pcm: Buffer) -> Buffer   // int16 PCM (320 samples) -> opus
  .decodeFrame(opus: Buffer) -> Buffer  // opus -> int16 PCM
  .start(onFrame: (opus:Buffer)=>void)  // mic -> opus frame every 20ms
  .play(opus: Buffer)                   // decode -> speaker jitter buffer
  .stop()
```

`node loopback.js` — echoes your mic to your speaker (encode→decode); use headphones.
