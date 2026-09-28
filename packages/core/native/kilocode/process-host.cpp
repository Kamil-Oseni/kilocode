#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <stdexcept>
#include <vector>

// Private handles stay with this guardian until contained membership is proved empty.
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE input) : value(input) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

struct Basic {
  LONG exit;
  PVOID peb;
  ULONG_PTR affinity;
  LONG priority;
  ULONG_PTR pid, parent;
};
using Query = LONG (WINAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);

uint64_t number(const wchar_t* text) {
  if (!text || !*text) throw std::runtime_error("Invalid native identity");
  uint64_t result = 0;
  for (const wchar_t* at = text; *at; ++at) {
    if (*at < L'0' || *at > L'9' || result > (UINT64_MAX - (*at - L'0')) / 10)
      throw std::runtime_error("Invalid native identity");
    result = result * 10 + (*at - L'0');
  }
  return result;
}

DWORD pid(const wchar_t* text) {
  const auto value = number(text);
  if (!value || value > MAXDWORD) throw std::runtime_error("Invalid native identity");
  return static_cast<DWORD>(value);
}

std::string token(const wchar_t* text) {
  const std::wstring value(text);
  if (value.size() != 36) throw std::runtime_error("Invalid receipt identity");
  std::string result;
  for (const auto chr : value) {
    if (!(chr >= L'0' && chr <= L'9') && !(chr >= L'a' && chr <= L'f') && chr != L'-')
      throw std::runtime_error("Invalid receipt identity");
    result.push_back(static_cast<char>(chr));
  }
  return result;
}

uint64_t birth(HANDLE handle) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(handle, &created, &exited, &kernel, &user))
    throw std::runtime_error("Native process identity unavailable");
  return (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}

HANDLE pin(DWORD id, uint64_t expected, DWORD access) {
  Handle handle(OpenProcess(access, FALSE, id));
  if (!handle.value || birth(handle.value) != expected)
    throw std::runtime_error("Native owner identity unavailable or changed");
  const HANDLE result = handle.value;
  handle.value = nullptr;
  return result;
}

struct Row {
  const char* status;
  uint64_t born = 0;
  DWORD parent = 0;
};

Row inspect(DWORD id, uint64_t expected, bool stop) {
  Handle handle(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION |
    (stop ? PROCESS_TERMINATE : 0), FALSE, id));
  if (!handle.value) return {GetLastError() == ERROR_INVALID_PARAMETER ? "gone" : "unknown"};
  uint64_t born = 0;
  try { born = birth(handle.value); }
  catch (const std::exception&) { return {"unknown"}; }
  if (expected && expected != born) return {"foreign", born};
  const DWORD state = WaitForSingleObject(handle.value, 0);
  if (state == WAIT_OBJECT_0) return {"gone", born};
  if (state != WAIT_TIMEOUT) return {"unknown", born};
  if (stop) {
    if (!TerminateProcess(handle.value, 1) && WaitForSingleObject(handle.value, 0) != WAIT_OBJECT_0)
      return {"unknown", born};
    return {WaitForSingleObject(handle.value, 2000) == WAIT_OBJECT_0 ? "confirmed" : "unknown", born};
  }
  const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  Basic basic{};
  ULONG size = 0;
  if (!query || query(handle.value, 0, &basic, sizeof(basic), &size) != 0 || size != sizeof(basic) ||
      basic.pid != id || basic.parent > MAXDWORD) return {"unknown", born};
  return {"owned", born, static_cast<DWORD>(basic.parent)};
}

void row(const Row& value) {
  std::printf("{\"status\":\"%s\",\"birth\":", value.status);
  if (value.born) std::printf("\"%llu\"", static_cast<unsigned long long>(value.born));
  else std::printf("null");
  std::printf(",\"parent\":%lu}", value.parent);
}

void snapshot() {
  Handle handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (handle.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Native snapshot unavailable");
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool found = Process32FirstW(handle.value, &entry) != FALSE;
  unsigned count = 0;
  std::printf("[");
  while (found) {
    if (count >= 32768) throw std::runtime_error("Native snapshot exceeded bound");
    const auto value = entry.th32ProcessID ? inspect(entry.th32ProcessID, 0, false) : Row{"unknown"};
    if (count++) std::printf(",");
    std::printf("{\"pid\":%lu,\"parent\":%lu,\"birth\":", entry.th32ProcessID,
      std::string(value.status) == "owned" ? value.parent : entry.th32ParentProcessID);
    if (std::string(value.status) == "owned") std::printf("\"%llu\"", static_cast<unsigned long long>(value.born));
    else std::printf("null");
    std::printf("}");
    found = Process32NextW(handle.value, &entry) != FALSE;
  }
  if (GetLastError() != ERROR_NO_MORE_FILES) throw std::runtime_error("Native snapshot incomplete");
  std::printf("]\n");
}

void write(const std::wstring& file, const std::string& data) {
  const auto temp = file + L".tmp";
  {
    Handle handle(CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
    DWORD count = 0;
    if (handle.value == INVALID_HANDLE_VALUE || !WriteFile(handle.value, data.data(), static_cast<DWORD>(data.size()), &count, nullptr) ||
        count != data.size() || !FlushFileBuffers(handle.value)) throw std::runtime_error("Native receipt write failed");
  }
  if (!MoveFileExW(temp.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Native receipt commit failed");
}

bool exists(const std::wstring& file) {
  if (GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES) return true;
  if (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND) return false;
  throw std::runtime_error("Native control state unavailable");
}

std::string read(const std::wstring& file) {
  Handle handle(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  char buffer[1025];
  DWORD count = 0;
  if (handle.value == INVALID_HANDLE_VALUE || !ReadFile(handle.value, buffer, sizeof(buffer), &count, nullptr) || count > 1024)
    throw std::runtime_error("Native admission receipt unavailable or oversized");
  return std::string(buffer, count);
}

std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t count = 0;
  for (const auto chr : value) {
    if (chr == L'\\') { ++count; continue; }
    result.append(chr == L'\"' ? count * 2 + 1 : count, L'\\');
    count = 0;
    result.push_back(chr);
  }
  result.append(count * 2, L'\\');
  return result + L"\"";
}

struct Envelope {
  std::vector<BYTE> data;
  size_t offset = 0;
  DWORD integer() {
    if (offset + 4 > data.size()) throw std::runtime_error("Native launch envelope truncated");
    const DWORD result = static_cast<DWORD>(data[offset]) | (static_cast<DWORD>(data[offset + 1]) << 8) |
      (static_cast<DWORD>(data[offset + 2]) << 16) | (static_cast<DWORD>(data[offset + 3]) << 24);
    offset += 4;
    return result;
  }
  std::wstring text() {
    const DWORD size = integer();
    if (size > 6144 || offset + static_cast<size_t>(size) * 2 > data.size())
      throw std::runtime_error("Native launch field exceeds bound");
    std::wstring result;
    for (DWORD at = 0; at < size; ++at) {
      const wchar_t chr = static_cast<wchar_t>(data[offset] | (data[offset + 1] << 8));
      if (!chr) throw std::runtime_error("Native launch field contains null");
      result.push_back(chr);
      offset += 2;
    }
    return result;
  }
};

void launch(DWORD controller, uint64_t parent, const std::wstring& control, const std::string& key) {
  Handle owner(pin(controller, parent, SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION));
  for (const auto suffix : {L".go", L".job", L".launch", L".drained", L".running", L".exited"})
    if (exists(control + suffix)) throw std::runtime_error("Native launch identity already used");
  const DWORD length = GetEnvironmentVariableW(L"RAYA_PTY_LAUNCH", nullptr, 0);
  if (!length || length > 16385) throw std::runtime_error("Native launch envelope unavailable or oversized");
  std::vector<wchar_t> encoded(length);
  if (GetEnvironmentVariableW(L"RAYA_PTY_LAUNCH", encoded.data(), length) != length - 1 ||
      !SetEnvironmentVariableW(L"RAYA_PTY_LAUNCH", nullptr)) throw std::runtime_error("Native launch envelope changed");
  DWORD size = 0;
  if (!CryptStringToBinaryW(encoded.data(), length - 1, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) ||
      size > 12288) throw std::runtime_error("Native launch envelope invalid");
  Envelope packet{std::vector<BYTE>(size)};
  if (!CryptStringToBinaryW(encoded.data(), length - 1, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, packet.data.data(), &size, nullptr, nullptr))
    throw std::runtime_error("Native launch envelope invalid");
  SecureZeroMemory(encoded.data(), encoded.size() * sizeof(wchar_t));
  if (packet.integer() != 1) throw std::runtime_error("Native launch contract unsupported");
  const DWORD timeout = packet.integer();
  if (timeout < 50 || timeout > 60000) throw std::runtime_error("Native launch admission deadline invalid");
  const auto command = packet.text();
  const auto cwd = packet.text();
  const DWORD count = packet.integer();
  if (command.empty() || cwd.empty() || count > 128 || !exists(cwd))
    throw std::runtime_error("Native launch target invalid");
  std::wstring args = quote(command);
  for (DWORD at = 0; at < count; ++at) args += L" " + quote(packet.text());
  if (packet.offset != packet.data.size() || args.size() >= 32767)
    throw std::runtime_error("Native launch envelope invalid");
  SecureZeroMemory(packet.data.data(), packet.data.size());
  Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    throw std::runtime_error("Native launch job unavailable");
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(command.c_str(), args.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      nullptr, cwd.c_str(), &startup, &child)) throw std::runtime_error("Native suspended launch failed");
  Handle process(child.hProcess);
  Handle thread(child.hThread);
  bool assigned = false;
  try {
    const auto born = birth(process.value);
    if (!AssignProcessToJobObject(job.value, process.value)) throw std::runtime_error("Native launch containment failed");
    assigned = true;
    const std::string identity = "\"pid\":" + std::to_string(child.dwProcessId) + ",\"birth\":\"" + std::to_string(born) + "\"";
    const std::string header = "{\"version\":1,\"token\":\"" + key + "\",\"proof\":\"windows-job\"," + identity;
    write(control + L".job", "{\"version\":2,\"token\":\"" + key + "\",\"proof\":\"windows-job\",\"assigned\":true}");
    write(control + L".launch", header + ",\"helper\":" + std::to_string(GetCurrentProcessId()) + ",\"helperBirth\":\"" +
      std::to_string(birth(GetCurrentProcess())) + "\",\"state\":\"suspended\"}");
    bool resumed = false, stopping = false;
    ULONGLONG deadline = GetTickCount64() + timeout;
    while (true) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
      if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr))
        throw std::runtime_error("Native launch membership unknown");
      if (!state.ActiveProcesses) {
        write(control + L".drained", "{\"version\":2,\"token\":\"" + key + "\",\"proof\":\"windows-job\",\"empty\":true}");
        DWORD code = 0;
        if (WaitForSingleObject(process.value, 2000) != WAIT_OBJECT_0 || !GetExitCodeProcess(process.value, &code)) {
          write(control + L".exited", header + ",\"state\":\"exited\",\"outcome\":\"unknown\"}");
          return;
        }
        write(control + L".exited", header + ",\"state\":\"exited\",\"exitCode\":" + std::to_string(code) +
          ",\"outcome\":\"" + (stopping || !resumed ? "cancelled" : "confirmed") + "\"}");
        return;
      }
      const DWORD status = WaitForSingleObject(owner.value, 0);
      if (status != WAIT_OBJECT_0 && status != WAIT_TIMEOUT) throw std::runtime_error("Native launch controller unknown");
      if (!stopping && (exists(control) || status == WAIT_OBJECT_0 || (!resumed && GetTickCount64() >= deadline))) {
        if (!TerminateJobObject(job.value, 1)) throw std::runtime_error("Native launch stop failed");
        stopping = true;
        deadline = GetTickCount64() + 60000;
      }
      if (!stopping && !resumed && exists(control + L".go")) {
        const auto admission = "{\"version\":1,\"token\":\"" + key + "\"," + identity + ",\"action\":\"resume\"}";
        if (read(control + L".go") != admission) throw std::runtime_error("Native admission identity changed");
        const DWORD current = WaitForSingleObject(owner.value, 0);
        if (current != WAIT_OBJECT_0 && current != WAIT_TIMEOUT) throw std::runtime_error("Native admission controller unknown");
        if (current == WAIT_OBJECT_0 || exists(control) || GetTickCount64() >= deadline) {
          if (!TerminateJobObject(job.value, 1)) throw std::runtime_error("Native admission cancellation failed");
          stopping = true;
          deadline = GetTickCount64() + 60000;
          continue;
        }
        if (ResumeThread(thread.value) != 1) throw std::runtime_error("Native launch resume unknown");
        resumed = true;
        write(control + L".running", header + ",\"state\":\"running\"}");
      }
      if (stopping && GetTickCount64() >= deadline) throw std::runtime_error("Native launch did not drain");
      Sleep(10);
    }
  } catch (const std::exception&) {
    if (!assigned && (!TerminateProcess(process.value, 1) || WaitForSingleObject(process.value, 2000) != WAIT_OBJECT_0))
      throw std::runtime_error("Native unadmitted target termination unknown");
    throw;
  }
}

void guard(DWORD id, uint64_t expected, DWORD controller, uint64_t parent, const std::wstring& control, const std::string& key) {
  Handle process(pin(id, expected, SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE));
  Handle owner(pin(controller, parent, SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION));
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.value) throw std::runtime_error("Native job unavailable");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job.value, process.value)) throw std::runtime_error("Native containment assignment failed");
  write(control + L".job", "{\"version\":2,\"token\":\"" + key + "\",\"proof\":\"windows-job\",\"assigned\":true}");
  bool stopping = false;
  ULONGLONG deadline = 0;
  while (true) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr))
      throw std::runtime_error("Native containment state unavailable");
    if (!state.ActiveProcesses) {
      write(control + L".drained", "{\"version\":2,\"token\":\"" + key + "\",\"proof\":\"windows-job\",\"empty\":true}");
      return;
    }
    const DWORD status = WaitForSingleObject(owner.value, 0);
    if (status != WAIT_OBJECT_0 && status != WAIT_TIMEOUT) throw std::runtime_error("Native controller state unavailable");
    const DWORD attrs = GetFileAttributesW(control.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES && GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND)
      throw std::runtime_error("Native stop state unavailable");
    if (!stopping && (attrs != INVALID_FILE_ATTRIBUTES || status == WAIT_OBJECT_0)) {
      if (!TerminateJobObject(job.value, 1)) throw std::runtime_error("Native containment termination failed");
      stopping = true;
      deadline = GetTickCount64() + 60000;
    }
    if (stopping && GetTickCount64() >= deadline) throw std::runtime_error("Native containment did not drain");
    Sleep(50);
  }
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--protocol") {
      std::printf("{\"version\":1,\"proof\":\"windows-job\",\"architecture\":\"x64\"}\n");
      return 0;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--launch-protocol") {
      std::printf("{\"version\":1,\"operation\":\"pty-launch\",\"proof\":\"windows-job\"}\n");
      return 0;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--pty-lifecycle-protocol") {
      std::printf("{\"version\":1,\"operation\":\"pty-lifecycle\",\"proof\":\"windows-job\",\"targetExit\":true}\n");
      return 0;
    }
    if (argc == 6 && std::wstring(argv[1]) == L"pty-launch") {
      launch(pid(argv[2]), number(argv[3]), argv[4], token(argv[5]));
      return 0;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
      const auto current = inspect(GetCurrentProcessId(), 0, false);
      if (std::string(current.status) != "owned" || !current.born ||
          std::string(inspect(GetCurrentProcessId(), current.born + 1, true).status) != "foreign")
        throw std::runtime_error("Native identity self-test failed");
      return 0;
    }
    if (argc == 3 && std::wstring(argv[1]) == L"inspect") { row(inspect(pid(argv[2]), 0, false)); return 0; }
    if (argc == 4 && std::wstring(argv[1]) == L"terminate") { row(inspect(pid(argv[2]), number(argv[3]), true)); return 0; }
    if (argc == 2 && std::wstring(argv[1]) == L"query") { snapshot(); return 0; }
    if (argc == 8 && std::wstring(argv[1]) == L"guard") {
      guard(pid(argv[2]), number(argv[3]), pid(argv[4]), number(argv[5]), argv[6], token(argv[7]));
      return 0;
    }
    throw std::runtime_error("Invalid native operation");
  } catch (const std::exception& err) {
    std::fprintf(stderr, "%s\n", err.what());
    return 1;
  }
}
