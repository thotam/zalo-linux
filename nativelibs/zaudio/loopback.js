const path = require('path');
const { ZAudio } = require(path.join(__dirname, 'build', 'Release', 'zaudio.node'));
const a = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });
let n = 0;
a.start((opus) => { a.play(opus); if (++n % 50 === 0) process.stdout.write('.'); });
console.log('loopback: speak — you should hear yourself (~40ms delay). Ctrl+C to stop. (use headphones)');
setTimeout(() => { a.stop(); process.exit(0); }, 15000);
