#define wmain diagnostic_entry
#include "../../native/kilocode/process-host.cpp"
#undef wmain

int wmain() {
  try {
    Source::Diagnostic state;
    std::map<DWORD, std::unique_ptr<Source::Member>> members;
    const auto id = GetCurrentProcessId();
    const auto born = birth(GetCurrentProcess());
    state.observe(id, GetCurrentProcess(), members);
    const auto key = std::make_pair(id, born);
    if (state.details.size() != 1 || !state.details.contains(key) || state.details.at(key).image == L"unknown")
      throw std::runtime_error("Actual handle identity or image unavailable");
    if (!state.details.at(key).pid || state.details.at(key).born)
      throw std::runtime_error("Parent PID missing or unretained parent birth fabricated");
    state.finish(id, born, 128);
    state.finish(id, born + 1, 1);
    if (!state.details.at(key).finished || state.details.at(key).code != 128 || state.unmapped != 1)
      throw std::runtime_error("Exact birth exit assignment failed");
    state.finish(id, born, 1);
    if (state.conflicts != 1 || state.details.at(key).code != 128)
      throw std::runtime_error("Contradictory exit replaced original diagnostic");
    for (DWORD pid = 1; state.details.size() < 4096; ++pid)
      state.retain(pid, 1, L"fixture.exe", L"parent.exe", 1, 1);
    state.retain(MAXDWORD, 2, L"fixture.exe", L"parent.exe", 1, 1);
    if (state.details.size() != 4096 || state.omitted != 1)
      throw std::runtime_error("Diagnostic member bound failed");
    const auto report = state.report();
    if (report.find("\"retirementAuthority\":false") == std::string::npos || report.find("\"parentBirth\":null") == std::string::npos || report.find("\"memberDropped\":1") == std::string::npos)
      throw std::runtime_error("Diagnostic authority or explicit omission failed");
    std::puts("{\"passed\":true,\"members\":4096,\"omitted\":1,\"realHandleObserved\":true,\"retirementAuthority\":false}");
    return 0;
  } catch (const std::exception& err) {
    std::fprintf(stderr, "%s\n", err.what());
    return 1;
  }
}
