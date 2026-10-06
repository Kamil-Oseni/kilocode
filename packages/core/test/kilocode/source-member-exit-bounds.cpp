// Exercise the real production diagnostic implementation; no process launch or retirement authority.
#define wmain diagnostic_entry
#include "process-host.cpp"
#undef wmain

int wmain() {
  try {
    Source::Diagnostic state;
    const auto key = std::make_pair(std::wstring(L"fixture.exe"), std::wstring(L"fixture.exe"));
    state.add(key.first, key.second, 10);
    state.labels.emplace(std::make_pair(1u, uint64_t{10}), key);
    for (DWORD code = 0; code < 128; ++code) state.finish(1, 10, code);
    if (state.buckets != 128 || state.exited != 128 || state.excess || state.unmapped)
      throw std::runtime_error("Exact 128 diagnostic buckets failed");
    state.finish(1, 10, 128);
    if (state.buckets != 128 || state.exited != 128 || state.excess != 1)
      throw std::runtime_error("129th diagnostic bucket was not refused");
    state.finish(1, 11, 0);
    state.finish(2, 10, 0);
    if (state.unmapped != 2 || state.exited != 128)
      throw std::runtime_error("Missing or foreign birth was attributed");
    state.labels.emplace(std::make_pair(1u, uint64_t{11}), key);
    state.finish(1, 11, 0);
    state.finish(1, 10, 0);
    if (state.unmapped != 2 || state.exited != 130 || state.rows.at(key).exits.at(0) != 3)
      throw std::runtime_error("Distinct births did not retain their own labels");
    const auto report = state.report();
    if (report.size() > 65536 || report.find("retirementAuthority\":false") == std::string::npos)
      throw std::runtime_error("Diagnostic privacy or bound failed");
    std::puts("{\"passed\":true,\"buckets\":128,\"dropped\":1,\"unavailable\":2,\"processesLaunched\":0,\"retirementAuthority\":false}");
    return 0;
  } catch (const std::exception& err) {
    std::fprintf(stderr, "%s\n", err.what());
    return 1;
  }
}
