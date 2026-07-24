{
  "targets": [{
    "target_name": "zaudio",
    "sources": ["src/zaudio.cpp", "src/miniaudio_impl.c"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<(module_root_dir)/.deps/include",
      "<(module_root_dir)/.deps/include/opus",
      "<(module_root_dir)/src"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_c": ["-O2"],
    "libraries": [
      "<(module_root_dir)/.deps/lib/libopus.a",
      "-Wl,--exclude-libs,ALL",
      "-ldl", "-lm", "-lpthread"
    ]
  }]
}
