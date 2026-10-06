// Diagnostic observations never confer retirement authority or change member retention.
struct Diagnostic {
  struct Row {
    uint64_t count = 0, first = 0, last = 0, minimum = UINT64_MAX, maximum = 0, reordered = 0;
  };
  std::map<std::pair<std::wstring, std::wstring>, Row> rows;
  uint64_t observed = 0, unavailable = 0, dropped = 0;
  uint64_t notifications = 0, opened = 0, queried = 0, unassigned = 0, duplicates = 0, settled = 0;
  uint64_t replaced = 0, capacity = 0, unsettled = 0, accounting = 0;
  DWORD first = 0, last = 0;
  DWORD handles = 0;
  uint64_t retained = 0, working = 0, peak = 0, memory = 0, pagefile = 0;
  bool measured = false;
  bool failed = false;
  void measure(size_t members) noexcept {
    retained = members;
    PROCESS_MEMORY_COUNTERS_EX value{};
    value.cb = sizeof(value);
    using Memory = BOOL(WINAPI*)(HANDLE, PPROCESS_MEMORY_COUNTERS, DWORD);
    const auto query = reinterpret_cast<Memory>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "K32GetProcessMemoryInfo"));
    measured = query && query(GetCurrentProcess(), reinterpret_cast<PPROCESS_MEMORY_COUNTERS>(&value), sizeof(value)) &&
      GetProcessHandleCount(GetCurrentProcess(), &handles);
    if (!measured) return;
    working = value.WorkingSetSize;
    peak = value.PeakWorkingSetSize;
    memory = value.PrivateUsage;
    pagefile = value.PeakPagefileUsage;
  }
  static std::wstring name(HANDLE handle) {
    wchar_t text[32768]{};
    DWORD size = 32768;
    if (!QueryFullProcessImageNameW(handle, 0, text, &size) || !size) return L"unknown";
    const std::wstring full(text, size);
    const auto split = full.find_last_of(L"\\/");
    auto leaf = full.substr(split == std::wstring::npos ? 0 : split + 1);
    if (leaf.empty() || leaf.size() > 128) return L"unknown";
    for (auto& chr : leaf) {
      if (chr >= L'A' && chr <= L'Z') chr = static_cast<wchar_t>(chr + L'a' - L'A');
      if (!((chr >= L'a' && chr <= L'z') || (chr >= L'0' && chr <= L'9') || chr == L'.' || chr == L'-' || chr == L'_'))
        return L"unknown";
    }
    return leaf;
  }
  void add(const std::wstring& image, const std::wstring& parent, uint64_t born) {
    ++observed;
    const auto key = std::make_pair(image, parent);
    if (!rows.contains(key) && rows.size() >= 128) { ++dropped; return; }
    auto& row = rows[key];
    if (!row.count) row.first = born;
    row.first = (std::min)(row.first, born);
    if (row.count && born < row.last) ++row.reordered;
    if (row.count && born >= row.last) {
      const auto gap = born - row.last;
      row.minimum = (std::min)(row.minimum, gap);
      row.maximum = (std::max)(row.maximum, gap);
    }
    row.last = (std::max)(row.last, born);
    ++row.count;
  }
  void observe(DWORD id, HANDLE handle, const std::map<DWORD, std::unique_ptr<Member>>& members) noexcept {
    try {
      const auto born = birth(handle);
      Basic basic{};
      ULONG count = 0;
      const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
      std::wstring parent = L"unknown";
      if (query && query(handle, 0, &basic, sizeof(basic), &count) >= 0 && count >= sizeof(basic) && basic.pid == id && basic.parent <= MAXDWORD) {
        const auto found = members.find(static_cast<DWORD>(basic.parent));
        if (found != members.end() && found->second->born <= born) parent = name(found->second->process.value);
      }
      const auto image = name(handle);
      if (image == L"unknown" || parent == L"unknown") ++unavailable;
      add(image, parent, born);
    } catch (const std::exception&) { failed = true; }
  }
  std::string report() const {
    std::string entries = "[";
    for (const auto& [key, row] : rows) {
      if (entries.size() > 1) entries += ",";
      entries += "{\"image\":" + json(key.first) + ",\"parentImage\":" + json(key.second) +
        ",\"observations\":" + std::to_string(row.count) + ",\"firstBirth\":\"" + std::to_string(row.first) +
        "\",\"lastBirth\":\"" + std::to_string(row.last) + "\",\"minimumGap100ns\":\"" +
        std::to_string(row.minimum == UINT64_MAX ? 0 : row.minimum) + "\",\"maximumGap100ns\":\"" + std::to_string(row.maximum) +
        "\",\"reordered\":" + std::to_string(row.reordered) + "}";
    }
    return "{\"version\":1,\"diagnosticOnly\":true,\"retirementAuthority\":false,\"observations\":" + std::to_string(observed) +
      ",\"unavailable\":" + std::to_string(unavailable) + ",\"dropped\":" + std::to_string(dropped) +
      ",\"failed\":" + (failed ? "true" : "false") + ",\"coverage\":{\"newProcess\":" + std::to_string(notifications) +
      ",\"openFailed\":" + std::to_string(opened) + ",\"firstOpenError\":" + std::to_string(first) +
      ",\"lastOpenError\":" + std::to_string(last) + ",\"queryFailed\":" + std::to_string(queried) +
      ",\"unassigned\":" + std::to_string(unassigned) + ",\"duplicateLive\":" + std::to_string(duplicates) +
      ",\"duplicateSettled\":" + std::to_string(settled) + ",\"replacedBirth\":" + std::to_string(replaced) +
      ",\"capacityRefused\":" + std::to_string(capacity) + ",\"unsettled\":" + std::to_string(unsettled) +
      ",\"accountingMismatch\":" + std::to_string(accounting) + "},\"resources\":{\"available\":" + (measured ? "true" : "false") +
      ",\"retainedMembers\":" + std::to_string(retained) + ",\"memberStructBytes\":" + std::to_string(sizeof(Member)) +
      ",\"processHandles\":" + std::to_string(handles) + ",\"workingSetBytes\":\"" + std::to_string(working) +
      "\",\"peakWorkingSetBytes\":\"" + std::to_string(peak) + "\",\"privateBytes\":\"" + std::to_string(memory) +
      "\",\"peakPagefileBytes\":\"" + std::to_string(pagefile) + "\"},\"groups\":" + entries + "]}";
  }
};
