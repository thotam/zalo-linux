{
  "targets": [{
    "target_name": "jxl",
    "sources": [
      "src/zjxl.cc", "src/info.cc", "src/decode.cc",
      "src/encode.cc", "src/resize.cc", "src/multi.cc"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include')\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include/opencv4')\")"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
    "libraries": [
      "<!(node -e \"process.stdout.write('-L'+require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/lib')\")",
      "-ljxl", "-ljxl_threads", "-lturbojpeg", "-lopencv_core", "-lopencv_imgproc",
      "-Wl,-rpath,'$$ORIGIN'"
    ]
  }]
}
