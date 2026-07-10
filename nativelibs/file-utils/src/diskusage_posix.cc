// Linux reimplementation of the Zalo `file-utils` native addon.
//
// The macOS/Windows binary (RE'd from `darwin/file-utils.node`, original source
// `../disk_usage/diskusage_posix.cpp`) exports exactly one SYNCHRONOUS function,
// `getDiskUsage(path)`, returning `{ available, free, total }` (doubles) from a
// single `statvfs(path)` call. This is a byte-identical-OUTPUT reimplementation.
//
// Formula (settled by Capstone disassembly of __Z14FetchDiskUsagePKc — the
// multiplier register rcx = f_frsize, read as a 64-bit qword; the three block
// counts read as dwords on mac where fsblkcnt_t is 32-bit):
//
//     available = (uint64_t)f_bavail * f_frsize
//     free      = (uint64_t)f_bfree  * f_frsize
//     total     = (uint64_t)f_blocks * f_frsize
//
// Property creation order (from the success path of RunFetchDiskUsage):
//     available, free, total
//
// Error messages (extracted from the binary's __cstring + throw-site operands):
//     0 args              -> "DISKUSAGE_WRONG_NUMBER_OF_ARGS"
//     non-string arg      -> "DISKUSAGE_INVALID_ARG_TYPE:  The \"path\" argument
//                             must be one of type string"   (note the double space)
//     statvfs() != 0      -> "DISKUSAGE_RUNTIME_ERROR: Get diskusage failed"
//     std::exception      -> "DISKUSAGE_EXCEPTION_ERROR: <what()>"
//     unknown C++ throw   -> "DISKUSAGE_UNKNOW_EXCEPTION"
//
// The mac binary wraps the work in a C++ try/catch dispatching on exception type;
// we mirror that (exceptions are enabled in binding.gyp) so error parity holds.
// `DISKUSAGE_INVALID_CALLBACK` exists in the mac binary as a dead string constant
// (no async/callback code path) — intentionally not implemented.

#include <napi.h>
#include <sys/statvfs.h>
#include <string>
#include <cstdint>
#include <exception>

Napi::Value RunFetchDiskUsage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() == 0) {
    throw Napi::Error::New(env, "DISKUSAGE_WRONG_NUMBER_OF_ARGS");
  }
  if (!info[0].IsString()) {
    throw Napi::Error::New(
        env,
        "DISKUSAGE_INVALID_ARG_TYPE:  The \"path\" argument must be one of type string");
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();

  try {
    struct statvfs buf;
    if (statvfs(path.c_str(), &buf) != 0) {
      throw Napi::Error::New(env, "DISKUSAGE_RUNTIME_ERROR: Get diskusage failed");
    }

    const uint64_t frsize = static_cast<uint64_t>(buf.f_frsize);
    Napi::Object out = Napi::Object::New(env);
    out.Set("available",
            Napi::Number::New(env, static_cast<double>(static_cast<uint64_t>(buf.f_bavail) * frsize)));
    out.Set("free",
            Napi::Number::New(env, static_cast<double>(static_cast<uint64_t>(buf.f_bfree) * frsize)));
    out.Set("total",
            Napi::Number::New(env, static_cast<double>(static_cast<uint64_t>(buf.f_blocks) * frsize)));
    return out;
  } catch (const Napi::Error&) {
    throw;  // already-mapped errors (e.g. the RUNTIME_ERROR above) propagate as-is
  } catch (const std::exception& e) {
    throw Napi::Error::New(env, std::string("DISKUSAGE_EXCEPTION_ERROR: ") + e.what());
  } catch (...) {
    throw Napi::Error::New(env, "DISKUSAGE_UNKNOW_EXCEPTION");
  }
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("getDiskUsage", Napi::Function::New(env, RunFetchDiskUsage));
  return exports;
}

NODE_API_MODULE(file_utils, InitAll)
