{
  "targets": [{
    "target_name": "zimage",
    "sources": ["src/zimage.cc", "src/thumbnail.cc", "src/thumbnail_fs.cc"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include')\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include/glib-2.0')\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/lib/glib-2.0/include')\")"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
    "libraries": [
      "<!(node -e \"const p=require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString(); process.stdout.write(require('child_process').execSync('PKG_CONFIG_PATH='+p+'/lib/pkgconfig:'+p+'/lib64/pkgconfig:'+p+'/share/pkgconfig pkg-config --libs vips-cpp').toString().trim())\")",
      "-Wl,-rpath,'$$ORIGIN'"
    ]
  }]
}
