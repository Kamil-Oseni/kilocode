#define wmain process_main
#include "process-host.cpp"
#undef wmain

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && !wcscmp(argv[1], L"child")) { Sleep(150); return 0; }
  try {
    Source::Diagnostic observations;
    std::map<DWORD, std::unique_ptr<Source::Member>> members;
    HANDLE own = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &own, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0))
      throw std::runtime_error("Controlled original root handle unavailable");
    members.emplace(GetCurrentProcessId(), std::make_unique<Source::Member>(own));
    observations.observe(GetCurrentProcessId(), own, members);
    wchar_t image[32768]{};
    const DWORD size = GetModuleFileNameW(nullptr, image, 32768);
    if (!size || size >= 32768) throw std::runtime_error("Controlled fixture image unavailable");
    for (int index = 0; index < 12; ++index) {
      std::wstring command = L"\"" + std::wstring(image, size) + L"\" child";
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION child{};
      if (!CreateProcessW(image, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child))
        throw std::runtime_error("Controlled original child launch failed");
      Handle process(child.hProcess), thread(child.hThread);
      observations.observe(child.dwProcessId, process.value, members);
      DWORD code = STILL_ACTIVE;
      if (WaitForSingleObject(process.value, 10000) != WAIT_OBJECT_0 || !GetExitCodeProcess(process.value, &code) || code != 0)
        throw std::runtime_error("Controlled original child did not join");
    }
    const auto name = Source::Diagnostic::name(own);
    if (observations.observed != 13 || observations.failed || observations.dropped || observations.rows.at({name, name}).count != 12)
      throw std::runtime_error("Original held-handle diagnostic aggregation failed");
    Source::Diagnostic bounded;
    for (int index = 0; index < 129; ++index) bounded.add(L"image" + std::to_wstring(index), L"parent", static_cast<uint64_t>(index + 1));
    if (bounded.rows.size() != 128 || bounded.observed != 129 || bounded.dropped != 1)
      throw std::runtime_error("Diagnostic group limit failed");
    bounded.add(L"image0", L"parent", 4);
    bounded.add(L"image0", L"parent", 2);
    const auto& row = bounded.rows.at({L"image0", L"parent"});
    if (row.count != 3 || row.first != 1 || row.last != 4 || row.reordered != 1 || row.minimum != 3 || row.maximum != 3)
      throw std::runtime_error("Diagnostic reordered birth accounting failed");
    const auto report = observations.report();
    if (report.find("\\\\") != std::string::npos || report.size() >= 65536)
      throw std::runtime_error("Diagnostic namespace or byte bound failed");
    std::puts("{\"passed\":true,\"originalControlledChildren\":12,\"observations\":13,\"boundedGroups\":128,\"retirementAuthority\":false}");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
