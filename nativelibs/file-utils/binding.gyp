{
  "targets": [{
    "target_name": "file-utils-native",
    "sources": ["src/diskusage_posix.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"]
  }]
}
