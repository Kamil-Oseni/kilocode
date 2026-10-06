// Diagnostic observations never confer retirement authority or change member retention.
struct Diagnostic {
  struct Row {
    uint64_t count = 0, first = 0, last = 0, minimum = UINT64_MAX, maximum = 0, reordered = 0;
    std::map<DWORD, uint64_t> exits;
  };
  std::map<std::pair<std::wstring, std::wstring>, Row> rows;
  std::map<std::pair<DWORD, uint64_t>, std::pair<std::wstring, std::wstring>> labels;
  struct Entry {
    std::wstring image, parent;
    DWORD pid = 0;
    uint64_t born = 0;
    bool finished = false;
    DWORD code = 0;
  };
  std::map<std::pair<DWORD, uint64_t>, Entry> details;
  uint64_t omitted = 0, conflicts = 0;
  void retain(DWORD id, uint64_t born, const std::wstring& image, const std::wstring& parent, DWORD pid, uint64_t prior) {
    const auto key = std::make_pair(id, born);
    if (details.contains(key)) return;
    if (details.size() >= 4096) { ++omitted; return; }
    details.emplace(key, Entry{image, parent, pid, prior, false, 0});
  }
  uint64_t exited = 0, unmapped = 0, excess = 0, buckets = 0;
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
      DWORD pid = 0;
      uint64_t prior = 0;
      if (query && query(handle, 0, &basic, sizeof(basic), &count) >= 0 && count >= sizeof(basic) && basic.pid == id && basic.parent <= MAXDWORD) {
        pid = static_cast<DWORD>(basic.parent);
        const auto found = members.find(pid);
        if (found != members.end() && found->second->born <= born) {
          parent = name(found->second->process.value);
          prior = found->second->born;
        }
      }
      const auto image = name(handle);
      if (image == L"unknown" || parent == L"unknown") ++unavailable;
      add(image, parent, born);
      retain(id, born, image, parent, pid, prior);
      const auto key = std::make_pair(image, parent);
      // Diagnostic.capacity is a refusal counter, not the authoritative 4096-member bound.
      if (labels.size() < 4096 && rows.contains(key)) labels.emplace(std::make_pair(id, born), key);
    } catch (const std::exception&) { failed = true; }
  }
  void finish(DWORD id, uint64_t born, DWORD code) noexcept {
    try {
      const auto entry = details.find(std::make_pair(id, born));
      if (entry != details.end()) {
        if (entry->second.finished && entry->second.code != code) ++conflicts;
        if (!entry->second.finished) {
          entry->second.finished = true;
          entry->second.code = code;
        }
      }
      const auto label = labels.find(std::make_pair(id, born));
      if (label == labels.end()) { ++unmapped; return; }
      const auto found = rows.find(label->second);
      if (found == rows.end()) { ++unmapped; return; }
      auto& exits = found->second.exits;
      if (!exits.contains(code)) {
        if (buckets >= 128) { ++excess; return; }
        ++buckets;
      }
      ++exits[code];
      ++exited;
    } catch (const std::exception&) { failed = true; }
  }
  std::string report() const {
    std::string members = "[";
    for (const auto& [key, entry] : details) {
      if (members.size() > 1) members += ",";
      members += "{\"pid\":" + std::to_string(key.first) + ",\"birth\":\"" + std::to_string(key.second) +
        "\",\"image\":" + json(entry.image) + ",\"parentImage\":" + json(entry.parent) +
        ",\"parentPID\":" + std::to_string(entry.pid) + ",\"parentBirth\":" +
        (entry.born ? "\"" + std::to_string(entry.born) + "\"" : "null") + ",\"code\":" +
        (entry.finished ? std::to_string(entry.code) : "null") + "}";
    }
    members += "]";
    std::string entries = "[";
    for (const auto& [key, row] : rows) {
      std::string exits = "[";
      for (const auto& [code, count] : row.exits) {
        if (exits.size() > 1) exits += ",";
        exits += "{\"code\":" + std::to_string(code) + ",\"count\":" + std::to_string(count) + "}";
      }
      exits += "]";
      if (entries.size() > 1) entries += ",";
      entries += "{\"image\":" + json(key.first) + ",\"parentImage\":" + json(key.second) +
        ",\"observations\":" + std::to_string(row.count) + ",\"firstBirth\":\"" + std::to_string(row.first) +
        "\",\"lastBirth\":\"" + std::to_string(row.last) + "\",\"minimumGap100ns\":\"" +
        std::to_string(row.minimum == UINT64_MAX ? 0 : row.minimum) + "\",\"maximumGap100ns\":\"" + std::to_string(row.maximum) +
        "\",\"reordered\":" + std::to_string(row.reordered) + ",\"exits\":" + exits + "}";
    }
    return "{\"version\":1,\"diagnosticOnly\":true,\"retirementAuthority\":false,\"observations\":" + std::to_string(observed) +
      ",\"unavailable\":" + std::to_string(unavailable) + ",\"dropped\":" + std::to_string(dropped) +
      ",\"failed\":" + (failed ? "true" : "false") + ",\"exitObserved\":" + std::to_string(exited) +
      ",\"exitUnavailable\":" + std::to_string(unmapped) + ",\"exitDropped\":" + std::to_string(excess) +
      ",\"coverage\":{\"newProcess\":" + std::to_string(notifications) +
      ",\"openFailed\":" + std::to_string(opened) + ",\"firstOpenError\":" + std::to_string(first) +
      ",\"lastOpenError\":" + std::to_string(last) + ",\"queryFailed\":" + std::to_string(queried) +
      ",\"unassigned\":" + std::to_string(unassigned) + ",\"duplicateLive\":" + std::to_string(duplicates) +
      ",\"duplicateSettled\":" + std::to_string(settled) + ",\"replacedBirth\":" + std::to_string(replaced) +
      ",\"capacityRefused\":" + std::to_string(capacity) + ",\"unsettled\":" + std::to_string(unsettled) +
      ",\"accountingMismatch\":" + std::to_string(accounting) + "},\"resources\":{\"available\":" + (measured ? "true" : "false") +
      ",\"retainedMembers\":" + std::to_string(retained) + ",\"memberStructBytes\":" + std::to_string(sizeof(Member)) +
      ",\"processHandles\":" + std::to_string(handles) + ",\"workingSetBytes\":\"" + std::to_string(working) +
      "\",\"peakWorkingSetBytes\":\"" + std::to_string(peak) + "\",\"privateBytes\":\"" + std::to_string(memory) +
      "\",\"peakPagefileBytes\":\"" + std::to_string(pagefile) + "\"},\"groups\":" + entries + "],\"memberDropped\":" + std::to_string(omitted) + ",\"memberConflicts\":" + std::to_string(conflicts) + ",\"members\":" + members + "}";
  }
};
