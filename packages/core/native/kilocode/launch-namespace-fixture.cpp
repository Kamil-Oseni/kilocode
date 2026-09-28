#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <cstddef>
#include <cstring>
#include <optional>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

// Private x64 research only. Never link this PEB layout into the production launcher.
struct Parameters {
  ULONG maximum, length, flags, debug;
  HANDLE console;
  ULONG consoleflags;
  HANDLE input, output, error;
  UNICODE_STRING directory;
  HANDLE handle;
};
static_assert(sizeof(void*) == 8 && offsetof(Parameters, handle) == 0x48);

struct Handle {
  HANDLE value;
  explicit Handle(HANDLE value) : value(value) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
};

void require(bool value, const char* text) { if (!value) throw std::runtime_error(text); }
void row(const std::string& name, bool success, DWORD error = 0) {
  std::printf("{\"case\":\"%s\",\"success\":%s,\"error\":%lu}\n", name.c_str(), success ? "true" : "false", error);
  std::fflush(stdout);
}

HANDLE open(const std::wstring& path, bool pin = false) {
  return CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE | (pin ? 0 : FILE_SHARE_DELETE), nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}
FILE_ID_INFO identity(HANDLE handle) {
  FILE_ID_INFO result{};
  require(GetFileInformationByHandleEx(handle, FileIdInfo, &result, sizeof(result)) != 0, "Physical identity unavailable");
  return result;
}
bool same(const FILE_ID_INFO& a, const FILE_ID_INFO& b) {
  return a.VolumeSerialNumber == b.VolumeSerialNumber && std::memcmp(a.FileId.Identifier, b.FileId.Identifier, 16) == 0;
}
std::wstring final(HANDLE handle, DWORD volume) {
  wchar_t buffer[4096]{};
  const auto count = GetFinalPathNameByHandleW(handle, buffer, 4096, FILE_NAME_NORMALIZED | volume);
  require(count && count < 4096, "Final directory path unavailable");
  return buffer;
}

struct Alias {
  std::wstring name;
  std::vector<std::wstring> targets;
  explicit Alias(std::wstring name) : name(name) {
    wchar_t buffer[8192]{};
    require(!QueryDosDeviceW(name.c_str(), buffer, 8192) && GetLastError() == ERROR_FILE_NOT_FOUND,
      "Disposable alias already exists or cannot be inspected");
  }
  void add(const std::wstring& target) {
    require(DefineDosDeviceW(DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM, name.c_str(), target.c_str()) != 0,
      "Disposable alias creation failed");
    targets.push_back(target);
    wchar_t buffer[8192]{};
    require(QueryDosDeviceW(name.c_str(), buffer, 8192) != 0 && target == buffer, "Alias target not observed");
  }
  bool clear() {
    bool success = true;
    while (!targets.empty()) {
      const auto target = targets.back();
      success = DefineDosDeviceW(DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM | DDD_REMOVE_DEFINITION |
        DDD_EXACT_MATCH_ON_REMOVE, name.c_str(), target.c_str()) != 0 && success;
      targets.pop_back();
    }
    wchar_t buffer[8192]{};
    return !QueryDosDeviceW(name.c_str(), buffer, 8192) && GetLastError() == ERROR_FILE_NOT_FOUND && success;
  }
  ~Alias() { if (!targets.empty() && !clear()) std::fprintf(stderr, "Disposable alias exact cleanup failed\n"); }
};

std::optional<FILE_ID_INFO> suspended(HANDLE process, const std::string& name) {
  USHORT machine = 0, native = 0;
  require(IsWow64Process2(process, &machine, &native) && machine == IMAGE_FILE_MACHINE_UNKNOWN &&
    native == IMAGE_FILE_MACHINE_AMD64, "Private observation only supports native x64");
  using Query = NTSTATUS (NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
  const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  require(query != nullptr, "Private process query unavailable");
  PROCESS_BASIC_INFORMATION information{};
  require(query(process, ProcessBasicInformation, &information, sizeof(information), nullptr) >= 0, "Private PEB query failed");
  PEB peb{};
  SIZE_T count = 0;
  require(ReadProcessMemory(process, information.PebBaseAddress, &peb, sizeof(peb), &count) && count == sizeof(peb), "Private PEB read failed");
  Parameters parameters{};
  require(ReadProcessMemory(process, peb.ProcessParameters, &parameters, sizeof(parameters), &count) &&
    count == sizeof(parameters) && parameters.length >= sizeof(parameters) && parameters.directory.Length > 0 &&
    parameters.directory.Length <= 8192 && parameters.directory.Length % sizeof(wchar_t) == 0 &&
    parameters.directory.MaximumLength >= parameters.directory.Length, "Private directory layout unavailable");
  HANDLE value = nullptr;
  if (!DuplicateHandle(process, parameters.handle, GetCurrentProcess(), &value, FILE_READ_ATTRIBUTES, FALSE, 0)) {
    const DWORD error = GetLastError();
    const auto address = reinterpret_cast<ULONG_PTR>(parameters.handle);
    std::printf("{\"case\":\"%s-inspection\",\"success\":false,\"error\":%lu,\"null\":%s,\"tag\":%llu,\"aligned\":%s,\"length\":%u,\"maximum\":%u}\n",
      name.c_str(), error, address == 0 ? "true" : "false", static_cast<unsigned long long>(address & 3),
      address % sizeof(void*) == 0 ? "true" : "false", parameters.directory.Length, parameters.directory.MaximumLength);
    std::fflush(stdout);
    return std::nullopt;
  }
  Handle directory(value);
  return identity(directory.value);
}

struct Child {
  PROCESS_INFORMATION process{};
  Handle job{CreateJobObjectW(nullptr, nullptr)};
  ~Child() {
    if (process.hProcess) {
      TerminateProcess(process.hProcess, 70);
      WaitForSingleObject(process.hProcess, 3000);
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
    }
  }
  bool start(const std::wstring& image, const std::wstring& cwd, const std::wstring& nonce, DWORD& error) {
    require(job.value != nullptr, "Private Job creation failed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0,
      "Private Job limit failed");
    std::wstring command = L"\"" + image + L"\" --child \"" + nonce + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, cwd.c_str(), &startup, &process)) {
      error = GetLastError();
      return false;
    }
    require(AssignProcessToJobObject(job.value, process.hProcess) != 0, "Private Job assignment failed");
    error = 0;
    return true;
  }
  void finish(bool resume) {
    if (resume) require(ResumeThread(process.hThread) == 1, "Private authorized resume failed");
    if (!resume) require(TerminateJobObject(job.value, 71) != 0, "Private suspended termination failed");
    require(WaitForSingleObject(process.hProcess, 3000) == WAIT_OBJECT_0, "Private child not gone");
    DWORD code = 0;
    require(GetExitCodeProcess(process.hProcess, &code) != 0 && (!resume || code == 0), "Private child failed");
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)
      && accounting.ActiveProcesses == 0, "Private Job not empty");
  }
  void loss() {
    require(CloseHandle(job.value) != 0, "Private controller handle close failed");
    job.value = nullptr;
    require(WaitForSingleObject(process.hProcess, 3000) == WAIT_OBJECT_0, "Controller loss did not stop suspended child");
  }
};

void probe(const std::string& name, const std::wstring& image, const std::wstring& cwd,
  const std::wstring& nonce, const FILE_ID_INFO& expected, bool authorize, bool required = false,
  const FILE_ID_INFO* alternate = nullptr) {
  Child child;
  DWORD error = 0;
  const bool created = child.start(image, cwd, nonce, error);
  row(name + "-create", created, error);
  require(created || !required, "Required ordinary path launch refused");
  if (!created) return;
  const auto observed = suspended(child.process.hProcess, name);
  if (!observed) {
    child.finish(false);
    row(name + "-job-empty", true);
    row(name + "-no-nonce", GetFileAttributesW(nonce.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND);
    return;
  }
  const bool match = same(expected, *observed);
  row(name + "-suspended-match", match);
  if (alternate) row(name + "-suspended-b", same(*alternate, *observed));
  require(match || !authorize, "Positive control directory mismatch");
  // A mismatched child remains suspended until Job termination. Authorization is independent of compatibility.
  child.finish(authorize && match);
  row(name + "-job-empty", true);
  if (!authorize || !match) {
    row(name + "-no-nonce", GetFileAttributesW(nonce.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND);
    return;
  }
  Handle file(CreateFileW(nonce.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  FILE_ID_INFO reported{};
  DWORD count = 0;
  require(file.value != INVALID_HANDLE_VALUE && ReadFile(file.value, &reported, sizeof(reported), &count, nullptr)
    && count == sizeof(reported) && same(reported, expected), "Resumed child directory report disagrees");
  row(name + "-child-match", true);
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 3 && std::wstring(argv[1]) == L"--child") {
      Handle directory(open(L"."));
      const auto observed = identity(directory.value);
      Handle file(CreateFileW(argv[2], GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
      DWORD count = 0;
      require(file.value != INVALID_HANDLE_VALUE && WriteFile(file.value, &observed, sizeof(observed), &count, nullptr)
        && count == sizeof(observed) && FlushFileBuffers(file.value), "Private child report failed");
      return 0;
    }
    const bool cleanup = argc == 4 && std::wstring(argv[1]) == L"--cleanup";
    require(argc == 3 || cleanup, "Private root and UUID required");
    const std::wstring root = argv[cleanup ? 2 : 1], uuid = argv[cleanup ? 3 : 2];
    wchar_t temporary[4096]{}, resolved[4096]{};
    const auto length = GetTempPathW(4096, temporary);
    const auto size = GetFullPathNameW(root.c_str(), 4096, resolved, nullptr);
    require(length && length < 4096 && size && size < 4096 && root == resolved && root.find(L'"') == std::wstring::npos &&
      root.substr(0, length) == temporary && root.substr(length).rfind(L"raya-launch-namespace-", 0) == 0 &&
      root.find(L'\\', length) == std::wstring::npos && root.find(L'/', length) == std::wstring::npos &&
      uuid.size() == 36 && uuid.find_first_not_of(L"0123456789abcdef-") == std::wstring::npos, "Private arguments refused");
    const auto attributes = GetFileAttributesW(root.c_str());
    require(attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
      !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "Disposable root is not a plain directory");
    HANDLE token = nullptr;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != 0, "Private token unavailable");
    Handle account(token);
    alignas(TOKEN_USER) BYTE buffer[512]{};
    DWORD count = 0;
    require(GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &count) &&
      !IsWellKnownSid(reinterpret_cast<TOKEN_USER*>(buffer)->User.Sid, WinLocalSystemSid), "Global DOS namespace refused");
    const auto a = root + L"\\a", b = root + L"\\b";
    if (cleanup) {
      const auto name = L"RayaLaunch-" + uuid;
      wchar_t mappings[8192]{};
      const auto extent = QueryDosDeviceW(name.c_str(), mappings, 8192);
      if (!extent) {
        require(GetLastError() == ERROR_FILE_NOT_FOUND, "Private rescue namespace query failed");
        row("rescue-alias-absent", true);
        return 0;
      }
      Handle first(open(a)), second(open(b));
      const auto left = final(first.value, VOLUME_NAME_NT), right = final(second.value, VOLUME_NAME_NT);
      std::vector<std::wstring> targets;
      for (size_t offset = 0; offset < extent && mappings[offset];) {
        const std::wstring target(mappings + offset);
        require((target == left || target == right) && targets.size() < 2, "Rescue found unowned alias definition");
        targets.push_back(target);
        offset += target.size() + 1;
      }
      for (const auto& target : targets)
        require(DefineDosDeviceW(DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM | DDD_REMOVE_DEFINITION |
          DDD_EXACT_MATCH_ON_REMOVE, name.c_str(), target.c_str()) != 0, "Rescue exact removal failed");
      require(!QueryDosDeviceW(name.c_str(), mappings, 8192) && GetLastError() == ERROR_FILE_NOT_FOUND,
        "Rescue alias still present");
      row("rescue-alias-absent", true);
      return 0;
    }
    require(CreateDirectoryW(a.c_str(), nullptr) && CreateDirectoryW(b.c_str(), nullptr), "Private directory creation failed");
    Handle first(open(a, true)), second(open(b, true));
    const auto before = identity(first.value), other = identity(second.value);
    require(!same(before, other), "Independent directories required");
    wchar_t executable[4096]{};
    require(GetModuleFileNameW(nullptr, executable, 4096) > 0, "Private image unavailable");
    const auto image = root + L"\\fixture.exe";
    require(CopyFileW(executable, image.c_str(), TRUE) != 0, "Private image copy failed");
    probe("plain", image, a, root + L"\\plain.nonce", before, true, true);
    Alias alias(L"RayaLaunch-" + uuid);
    alias.add(final(first.value, VOLUME_NAME_NT));
    const std::vector<std::wstring> forms = {L"\\\\?\\" + alias.name + L"\\", L"\\\\.\\" + alias.name + L"\\",
      L"\\\\?\\GLOBALROOT\\??\\" + alias.name + L"\\"};
    for (size_t index = 0; index < forms.size(); ++index) {
      Handle current(open(forms[index]));
      row("alias-" + std::to_string(index) + "-open-a", current.value != INVALID_HANDLE_VALUE && same(before, identity(current.value)),
        current.value == INVALID_HANDLE_VALUE ? GetLastError() : 0);
    }
    alias.add(final(second.value, VOLUME_NAME_NT));
    row("pinned-a-unchanged", same(before, identity(first.value)));
    const auto unowned = final(first.value, VOLUME_NAME_NT) + L"\\unowned-" + uuid;
    const bool unexpected = DefineDosDeviceW(DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM | DDD_REMOVE_DEFINITION |
      DDD_EXACT_MATCH_ON_REMOVE, alias.name.c_str(), unowned.c_str()) != 0;
    const DWORD refusal = unexpected ? 0 : GetLastError();
    wchar_t target[8192]{};
    const bool retained = QueryDosDeviceW(alias.name.c_str(), target, 8192) != 0 &&
      final(second.value, VOLUME_NAME_NT) == target;
    row("alias-wrong-removal-refused", !unexpected && retained, refusal);
    require(!unexpected && retained, "Nonmatching exact removal changed the alias");
    for (size_t index = 0; index < forms.size(); ++index) {
      Handle current(open(forms[index]));
      row("alias-" + std::to_string(index) + "-open-b", current.value != INVALID_HANDLE_VALUE && same(other, identity(current.value)),
        current.value == INVALID_HANDLE_VALUE ? GetLastError() : 0);
      probe("alias-" + std::to_string(index), image, forms[index], root + L"\\alias-" + std::to_wstring(index) + L".nonce",
        before, false, false, &other);
    }
    const bool removed = alias.clear();
    row("alias-exact-removed", removed);
    require(removed, "Alias exact removal did not leave namespace empty");
    for (size_t index = 0; index < forms.size(); ++index)
      probe("removed-" + std::to_string(index), image, forms[index], root + L"\\removed-" + std::to_wstring(index) + L".nonce", before, false);
    const auto guid = final(first.value, VOLUME_NAME_GUID);
    probe("guid-cwd", image, guid, root + L"\\guid-cwd.nonce", before, true);
    Handle binary(CreateFileW(image.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    probe("guid-image", final(binary.value, VOLUME_NAME_GUID), a, root + L"\\guid-image.nonce", before, true);
    probe("guid-both", final(binary.value, VOLUME_NAME_GUID), guid, root + L"\\guid-both.nonce", before, true);
    {
      Child child;
      DWORD error = 0;
      const auto nonce = root + L"\\loss.nonce";
      require(child.start(image, a, nonce, error), "Controller loss child creation failed");
      const auto observed = suspended(child.process.hProcess, "controller-handle-loss");
      require(!observed || same(before, *observed), "Controller loss child directory mismatch");
      child.loss();
      row("controller-handle-loss-gone", true);
      row("controller-handle-loss-no-nonce", GetFileAttributesW(nonce.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND);
    }
    row("experiment-finished", same(before, identity(first.value)) && same(other, identity(second.value)));
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s (Win32=%lu)\n", error.what(), GetLastError());
    return 1;
  }
}
