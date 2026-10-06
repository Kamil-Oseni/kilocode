#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

struct Child {
  PROCESS_INFORMATION process{};
  uint64_t born = 0;
  DWORD code = STILL_ACTIVE;
  ~Child() {
    if (process.hThread) CloseHandle(process.hThread);
    if (process.hProcess) CloseHandle(process.hProcess);
  }
  void join() {
    if (WaitForSingleObject(process.hProcess, 30000) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess(process.hProcess, &code) || code != 0)
      throw std::runtime_error("Original zero-delay child failed to join");
  }
};

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && !wcscmp(argv[1], L"child")) return 0;
  try {
    if (argc != 2) throw std::runtime_error("Controlled source member mode required");
    const bool sequential = !wcscmp(argv[1], L"sequential");
    const bool parallel = !wcscmp(argv[1], L"parallel");
    const bool large = !wcscmp(argv[1], L"large");
    const bool overflow = !wcscmp(argv[1], L"overflow");
    if (!sequential && !parallel && !large && !overflow) throw std::runtime_error("Controlled source member mode invalid");
    const unsigned count = overflow ? 4097 : large ? 1536 : parallel ? 128 : 64;
    const unsigned width = parallel ? 8 : 1;
    wchar_t image[32768]{};
    const DWORD length = GetModuleFileNameW(nullptr, image, 32768);
    if (!length || length >= 32768) throw std::runtime_error("Controlled fixture image unavailable");
    std::string rows = "[";
    for (unsigned index = 0; index < count; index += width) {
      std::vector<std::unique_ptr<Child>> children;
      for (unsigned slot = 0; slot < width && index + slot < count; ++slot) {
        auto child = std::make_unique<Child>();
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        std::wstring command = L"\"" + std::wstring(image, length) + L"\" child";
        if (!CreateProcessW(image, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                            nullptr, nullptr, &startup, &child->process))
          throw std::runtime_error("Controlled zero-delay child launch failed");
        FILETIME born{}, exited{}, kernel{}, user{};
        if (!GetProcessTimes(child->process.hProcess, &born, &exited, &kernel, &user))
          throw std::runtime_error("Original child birth unavailable");
        child->born = (static_cast<uint64_t>(born.dwHighDateTime) << 32) | born.dwLowDateTime;
        children.push_back(std::move(child));
      }
      for (const auto& child : children) {
        child->join();
        if (rows.size() > 1) rows += ",";
        rows += "{\"pid\":" + std::to_string(child->process.dwProcessId) + ",\"birth\":\"" +
          std::to_string(child->born) + "\",\"code\":" + std::to_string(child->code) + "}";
      }
    }
    rows += "]";
    std::printf("{\"count\":%u,\"width\":%u,\"intentionalDelayMs\":0,\"children\":%s}\n", count, width, rows.c_str());
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
