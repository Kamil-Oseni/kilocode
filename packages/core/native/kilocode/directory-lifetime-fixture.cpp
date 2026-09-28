// Private research fixture. Never shipped with the production native helper.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>
#include <stdexcept>
#include <fstream>
#include <sstream>

struct Handle {
  HANDLE value;
  explicit Handle(HANDLE input) : value(input) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
unsigned long long birth(HANDLE process) {
  FILETIME made{}, ended{}, kernel{}, user{};
  require(GetProcessTimes(process, &made, &ended, &kernel, &user) != 0, "birth unavailable");
  ULARGE_INTEGER value{}; value.LowPart = made.dwLowDateTime; value.HighPart = made.dwHighDateTime;
  return value.QuadPart;
}
std::wstring executable() {
  wchar_t buffer[32768]{};
  const DWORD size = GetModuleFileNameW(nullptr, buffer, 32768);
  require(size && size < 32768, "fixture executable unavailable");
  return std::wstring(buffer, size);
}
PROCESS_INFORMATION spawn(const std::wstring& arguments, bool suspended = false) {
  std::wstring command = L"\"" + executable() + L"\" " + arguments;
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
    CREATE_NO_WINDOW | (suspended ? CREATE_SUSPENDED : 0), nullptr, nullptr, &startup, &child) != 0, "spawn failed");
  return child;
}
void record(const std::wstring& file, const std::string& value) {
  Handle handle(CreateFileW(file.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(handle.value != INVALID_HANDLE_VALUE, "report open failed");
  DWORD written = 0;
  require(WriteFile(handle.value, value.data(), static_cast<DWORD>(value.size()), &written, nullptr) &&
    written == value.size() && FlushFileBuffers(handle.value), "report write failed");
}
std::string content(const std::wstring& file) {
  Handle handle(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (handle.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND) return "";
  require(handle.value != INVALID_HANDLE_VALUE, "report read failed");
  char buffer[8192]{}; DWORD size = 0;
  require(ReadFile(handle.value, buffer, sizeof(buffer), &size, nullptr) && size < sizeof(buffer), "report exceeds bound");
  return std::string(buffer, size);
}
bool gone(HANDLE process) {
  const DWORD value = WaitForSingleObject(process, 0);
  require(value == WAIT_TIMEOUT || value == WAIT_OBJECT_0, "process wait failed");
  return value == WAIT_OBJECT_0;
}
void stop(HANDLE process) {
  if (!gone(process)) require(TerminateProcess(process, 1) != 0, "synthetic process termination failed");
  require(WaitForSingleObject(process, 5000) == WAIT_OBJECT_0, "synthetic process exit unknown");
}
void keeper(const std::wstring& root, DWORD controller, unsigned long long cborn,
            DWORD helper, unsigned long long hborn, bool detached) {
  Handle owner(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, controller));
  Handle worker(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, helper));
  require(owner.value && worker.value && birth(owner.value) == cborn && birth(worker.value) == hborn, "owner identity mismatch");
  Handle pin(CreateFileW((root + L"\\guard").c_str(), FILE_LIST_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(pin.value != INVALID_HANDLE_VALUE, "directory pin unavailable");
  Handle witness(CreateFileW((root + L"\\guard\\witness").c_str(), GENERIC_READ,
    FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(witness.value != INVALID_HANDLE_VALUE, "witness unavailable");
  Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(job.value && SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job unavailable");
  const auto child = spawn(L"leader \"" + root + L"\" " + (detached ? L"exit" : L"wait"), true);
  Handle process(child.hProcess); Handle thread(child.hThread);
  require(AssignProcessToJobObject(job.value, process.value) != 0, "job assignment failed");
  record(root + L"\\report", "leader " + std::to_string(child.dwProcessId) + " " + std::to_string(birth(process.value)) + "\n");
  require(ResumeThread(thread.value) == 1, "resume failed");
  bool stopping = false;
  const ULONGLONG deadline = GetTickCount64() + 10000;
  while (GetTickCount64() < deadline) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
    require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr), "accounting unavailable");
    if (!state.ActiveProcesses) {
      record(root + L"\\report", "empty " + std::to_string(GetTickCount64()) + "\n");
      return;
    }
    if (!stopping && (gone(owner.value) || gone(worker.value) || GetFileAttributesW((root + L"\\stop").c_str()) != INVALID_FILE_ATTRIBUTES)) {
      record(root + L"\\report", "terminate " + std::to_string(state.ActiveProcesses) + "\n");
      require(TerminateJobObject(job.value, 1), "job termination failed");
      stopping = true;
    }
    Sleep(1);
  }
  throw std::runtime_error("keeper drainage timed out");
}

void observe(const std::wstring& root, const std::string& mode) {
  require(CreateDirectoryW((root + L"\\guard").c_str(), nullptr), "guard create failed");
  const auto controller = spawn(L"sleep"); Handle owner(controller.hProcess); Handle ot(controller.hThread);
  const auto helper = spawn(L"sleep"); Handle worker(helper.hProcess); Handle wt(helper.hThread);
  const auto guardian = spawn(L"keeper \"" + root + L"\" " + std::to_wstring(controller.dwProcessId) + L" " +
    std::to_wstring(birth(owner.value)) + L" " + std::to_wstring(helper.dwProcessId) + L" " +
    std::to_wstring(birth(worker.value)) + L" " + (mode == "leader" ? L"exit" : L"wait"));
  Handle keeper(guardian.hProcess); Handle kt(guardian.hThread);
  HANDLE leader = nullptr, leaf = nullptr;
  DWORD lpid = 0, dpid = 0; unsigned long long lborn = 0, dborn = 0;
  const ULONGLONG deadline = GetTickCount64() + 10000;
  while (GetTickCount64() < deadline && (!leader || !leaf)) {
    std::istringstream rows(content(root + L"\\report")); std::string key;
    while (rows >> key) {
      DWORD pid = 0; unsigned long long born = 0; std::string rest;
      if (key != "leader" && key != "leaf") { std::getline(rows, rest); continue; }
      require(static_cast<bool>(rows >> pid >> born), "identity report malformed");
      HANDLE& slot = key == "leader" ? leader : leaf;
      if (slot) continue;
      slot = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, FALSE, pid);
      require(slot && birth(slot) == born, "observed identity mismatch");
      if (key == "leader") { lpid = pid; lborn = born; } else { dpid = pid; dborn = born; }
    }
    Sleep(1);
  }
  Handle target(leader); Handle descendant(leaf);
  require(leader && leaf, "known process identities missing");
  record(root + L"\\observed", "observed");
  const bool detached = mode == "leader";
  if (detached) require(WaitForSingleObject(leader, 5000) == WAIT_OBJECT_0 && !gone(leaf), "living detached descendant missing");
  require(!MoveFileExW((root + L"\\guard").c_str(), (root + L"\\moved").c_str(), 0) && GetLastError() == ERROR_SHARING_VIOLATION,
    "pin did not exclude pre-interruption rename");
  if (mode == "controller") require(TerminateProcess(owner.value, 1), "controller termination failed");
  else if (mode == "helper") require(TerminateProcess(worker.value, 1), "helper termination failed");
  else if (mode == "keeper") require(TerminateProcess(keeper.value, 1), "keeper termination failed");
  else record(root + L"\\stop", "stop");
  unsigned attempts = 0, live = 0; ULONGLONG released = 0, lexit = 0, dexit = 0;
  while (GetTickCount64() < deadline) {
    const bool lgone = gone(leader), dgone = gone(leaf);
    if (lgone && !lexit) lexit = GetTickCount64();
    if (dgone && !dexit) dexit = GetTickCount64();
    if (!released) {
      ++attempts;
      if (MoveFileExW((root + L"\\guard").c_str(), (root + L"\\moved").c_str(), 0)) {
        released = GetTickCount64();
        if (!gone(leader) || !gone(leaf)) ++live;
        require(CreateDirectoryW((root + L"\\guard").c_str(), nullptr), "replacement create failed");
      } else require(GetLastError() == ERROR_SHARING_VIOLATION || GetLastError() == ERROR_ACCESS_DENIED, "unexpected mutation refusal");
    }
    if (released && lgone && dgone && gone(keeper.value)) break;
    Sleep(0);
  }
  stop(leader); stop(leaf); stop(keeper.value); stop(owner.value); stop(worker.value);
  const bool empty = content(root + L"\\report").find("empty ") != std::string::npos;
  require(released && lexit && dexit, "bounded observation incomplete");
  std::printf("{\"case\":\"%s\",\"leader\":%lu,\"leaderBirth\":\"%llu\",\"leaf\":%lu,\"leafBirth\":\"%llu\",\"attempts\":%u,\"liveMutation\":%u,\"released\":%llu,\"leaderExit\":%llu,\"leafExit\":%llu,\"emptyObserved\":%s}\n",
    mode.c_str(), lpid, lborn, dpid, dborn, attempts, live, released, lexit, dexit, empty ? "true" : "false");
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"sleep") { Sleep(15000); return 0; }
    if (argc == 3 && std::wstring(argv[1]) == L"leaf") {
      record(std::wstring(argv[2]) + L"\\report", "leaf " + std::to_string(GetCurrentProcessId()) + " " + std::to_string(birth(GetCurrentProcess())) + "\n");
      Sleep(15000); return 0;
    }
    if (argc == 4 && std::wstring(argv[1]) == L"leader") {
      const auto child = spawn(L"leaf \"" + std::wstring(argv[2]) + L"\"");
      Handle process(child.hProcess); Handle thread(child.hThread);
      if (std::wstring(argv[3]) == L"exit") {
        const ULONGLONG deadline = GetTickCount64() + 10000;
        while (GetFileAttributesW((std::wstring(argv[2]) + L"\\observed").c_str()) == INVALID_FILE_ATTRIBUTES &&
          GetTickCount64() < deadline) Sleep(1);
        require(GetTickCount64() < deadline, "observer identity acknowledgement timed out");
        return 0;
      }
      Sleep(15000); return 0;
    }
    if (argc == 8 && std::wstring(argv[1]) == L"keeper") {
      keeper(argv[2], std::stoul(argv[3]), std::stoull(argv[4]), std::stoul(argv[5]), std::stoull(argv[6]), std::wstring(argv[7]) == L"exit");
      return 0;
    }
    require(argc == 3, "invalid fixture arguments");
    const std::wstring name(argv[2]);
    require(name == L"normal" || name == L"controller" || name == L"helper" || name == L"leader" || name == L"keeper", "invalid case");
    const std::string mode = name == L"normal" ? "normal" : name == L"controller" ? "controller" :
      name == L"helper" ? "helper" : name == L"leader" ? "leader" : "keeper";
    observe(argv[1], mode); return 0;
  } catch (const std::exception& err) { std::fprintf(stderr, "%s\n", err.what()); return 1; }
}
