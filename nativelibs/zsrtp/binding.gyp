{
  "targets": [{
    "target_name": "zsrtp",
    "sources": ["src/zsrtp.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<(module_root_dir)/.deps/include"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "libraries": [
      "<(module_root_dir)/.deps/lib/libsrtp2.a",
      "-Wl,--exclude-libs,ALL",
      "-lpthread", "-lm"
    ]
  }]
}
