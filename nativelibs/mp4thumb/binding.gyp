{
  "targets": [{
    "target_name": "mp4thumb",
    "sources": ["src/mp4thumb.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include')\")"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "libraries": [
      "<!(node -e \"process.stdout.write('-L'+require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/lib')\")",
      "-Wl,--start-group",
      "-l:libavformat.a", "-l:libavcodec.a", "-l:libswscale.a", "-l:libswresample.a", "-l:libavutil.a",
      "-Wl,--end-group",
      "-Wl,--exclude-libs,ALL",
      "-lssl", "-lcrypto", "-lz", "-lm", "-lpthread", "-ldl"
    ]
  }]
}
