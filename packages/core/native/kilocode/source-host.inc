#include <map>
#include <memory>
#include <algorithm>
#include <psapi.h>

// This protocol is separate from PTY cancellation. Root/controller exit never
// terminates persistent descendants. Only an explicit correlated abort forces.
namespace Source {
std::string json(const std::wstring& value) {
  const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (!size && !value.empty()) throw std::runtime_error("Native source text invalid");
  std::string utf(static_cast<size_t>(size), 0);
  if (size && WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), utf.data(), size, nullptr, nullptr) != size)
    throw std::runtime_error("Native source text conversion failed");
  std::string result = "\"";
  const char* hex = "0123456789abcdef";
  for (const unsigned char chr : utf) {
    if (chr == '\\' || chr == '"') { result += '\\'; result += static_cast<char>(chr); }
    else if (chr < 32) { result += "\\u00"; result += hex[chr >> 4]; result += hex[chr & 15]; }
    else result += static_cast<char>(chr);
  }
  return result + "\"";
}

std::wstring canonical(const std::wstring& file) {
  if (file.size() < 3 || file.size() > 4096 || file[1] != L':' || file[2] != L'\\')
    throw std::runtime_error("Native source root must use an absolute DOS path");
  wchar_t full[4101]{};
  const auto length = GetFullPathNameW(file.c_str(), 4101, full, nullptr);
  if (!length || length >= 4101 || _wcsicmp(full, file.c_str())) throw std::runtime_error("Native source path is not normalized");
  std::wstring current = file;
  std::wstring suffix;
  while (true) {
    Handle handle(CreateFileW(current.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (handle.value != INVALID_HANDLE_VALUE) {
      wchar_t physical[4101]{};
      const auto count = GetFinalPathNameByHandleW(handle.value, physical, 4101, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
      if (!count || count >= 4101 || std::wstring(physical).substr(0, 4) != L"\\\\?\\") throw std::runtime_error("Native source root unavailable");
      std::wstring result(physical + 4);
      if (!suffix.empty() && result.back() == L'\\') result.pop_back();
      return result + suffix;
    }
    const auto error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) throw std::runtime_error("Native source path inspection failed");
    const auto split = current.find_last_of(L'\\');
    if (split == std::wstring::npos || current.size() <= 3) throw std::runtime_error("Native source path ancestor unavailable");
    suffix = current.substr(split) + suffix;
    current = current.substr(0, split == 2 ? 3 : split);
  }
}

std::string hash(HANDLE file) {
  Algorithm algorithm;
  DWORD size = 0, count = 0;
  if (BCryptGetProperty(algorithm.value, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &count, 0) < 0 || !size || size > 65536)
    throw std::runtime_error("Native source hash object unavailable");
  std::vector<BYTE> object(size);
  BCRYPT_HASH_HANDLE state = nullptr;
  if (BCryptCreateHash(algorithm.value, &state, object.data(), size, nullptr, 0, 0) < 0) throw std::runtime_error("Native source hashing unavailable");
  try {
    std::vector<BYTE> buffer(65536);
    while (true) {
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) throw std::runtime_error("Native source image read failed");
      if (!read) break;
      if (BCryptHashData(state, buffer.data(), read, 0) < 0) throw std::runtime_error("Native source image hash failed");
    }
    BYTE bytes[32]{};
    if (BCryptFinishHash(state, bytes, sizeof(bytes), 0) < 0) throw std::runtime_error("Native source hash incomplete");
    BCryptDestroyHash(state);
    std::string result;
    const char* hex = "0123456789abcdef";
    for (const auto chr : bytes) { result += hex[chr >> 4]; result += hex[chr & 15]; }
    return result;
  } catch (...) { BCryptDestroyHash(state); throw; }
}

struct PublicationPending : std::runtime_error { PublicationPending() : std::runtime_error("Native source control publication is pending") {} };

Envelope packet(const std::wstring& file) {
  Handle handle(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (handle.value == INVALID_HANDLE_VALUE) {
    const auto error = GetLastError();
    if (error == ERROR_SHARING_VIOLATION) throw PublicationPending();
    throw std::runtime_error("Native source control open failed: " + std::to_string(error));
  }
  BY_HANDLE_FILE_INFORMATION info{};
  LARGE_INTEGER size{};
  if (!GetFileInformationByHandle(handle.value, &info)) throw std::runtime_error("Native source control identity read failed: " + std::to_string(GetLastError()));
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1) throw std::runtime_error("Native source control type or link identity invalid");
  if (!GetFileSizeEx(handle.value, &size)) throw std::runtime_error("Native source control size read failed: " + std::to_string(GetLastError()));
  if (size.QuadPart < 4 || size.QuadPart > 1048576) throw std::runtime_error("Native source control size invalid");
  Envelope result{std::vector<BYTE>(static_cast<size_t>(size.QuadPart))};
  DWORD count = 0;
  if (!ReadFile(handle.value, result.data.data(), static_cast<DWORD>(result.data.size()), &count, nullptr) || count != result.data.size())
    throw std::runtime_error("Native source control packet incomplete");
  return result;
}

struct Member {
  Handle process;
  uint64_t born;
  DWORD code = STILL_ACTIVE;
  bool settled = false;
  explicit Member(HANDLE handle) : process(handle), born(birth(handle)) {}
  bool close(DWORD timeout = 0) {
    if (settled) return true;
    if (WaitForSingleObject(process.value, timeout) != WAIT_OBJECT_0) return false;
    if (!GetExitCodeProcess(process.value, &code) || code == STILL_ACTIVE) throw std::runtime_error("Native source member exact exit unavailable");
    settled = true;
    return true;
  }
};

// Match the public receipt parser's existing bound; retained handles prohibit PID reuse.
constexpr size_t capacity = 4096;

#include "source-diagnostic.inc"

bool inside(const std::wstring& directory, const std::wstring& file) {
  return file.size() >= directory.size() && !_wcsnicmp(file.c_str(), directory.c_str(), directory.size()) &&
    (file.size() == directory.size() || file[directory.size()] == L'\\');
}

std::wstring lower(std::wstring file) {
  if (LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, file.data(), static_cast<int>(file.size()), file.data(), static_cast<int>(file.size()), nullptr, nullptr, 0) != static_cast<int>(file.size()))
    throw std::runtime_error("Native source policy case normalization failed");
  return file;
}

int start(DWORD controller, uint64_t parent, const std::wstring& control, const std::string& key) {
  Handle owner(pin(controller, parent, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION));
  if (_wcsicmp(canonical(control).c_str(), control.c_str())) throw std::runtime_error("Native source control root changed");
  for (const auto suffix : {L".source-launch", L".source-go", L".source-capture", L".source-capture-ready", L".source-abort", L".source-retired", L".source-family-retired", L".source-root-exited", L".source-broker"})
    if (exists(control + suffix)) throw std::runtime_error("Native source generation already used");
  const DWORD length = GetEnvironmentVariableW(L"RAYA_SOURCE_LAUNCH", nullptr, 0);
  if (!length || length > 32768) throw std::runtime_error("Native source envelope unavailable");
  std::vector<wchar_t> encoded(length);
  if (GetEnvironmentVariableW(L"RAYA_SOURCE_LAUNCH", encoded.data(), length) != length - 1 || !SetEnvironmentVariableW(L"RAYA_SOURCE_LAUNCH", nullptr))
    throw std::runtime_error("Native source envelope changed");
  DWORD size = 0;
  if (!CryptStringToBinaryW(encoded.data(), length - 1, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) || size > 24576)
    throw std::runtime_error("Native source envelope oversized");
  Envelope input{std::vector<BYTE>(size)};
  if (!CryptStringToBinaryW(encoded.data(), length - 1, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, input.data.data(), &size, nullptr, nullptr))
    throw std::runtime_error("Native source envelope invalid");
  SecureZeroMemory(encoded.data(), encoded.size() * sizeof(wchar_t));
  const DWORD version = input.integer();
  if (version != 1 && version != 2) throw std::runtime_error("Native source protocol unsupported");
  const DWORD timeout = input.integer();
  if (timeout < 100 || timeout > 60000) throw std::runtime_error("Native source launch timeout invalid");
  const auto command = input.text();
  const auto expected = input.text();
  const auto cwd = input.text();
  if (_wcsicmp(canonical(command).c_str(), command.c_str()) || _wcsicmp(canonical(cwd).c_str(), cwd.c_str()) || expected.size() != 64 || expected.find_first_not_of(L"0123456789abcdef") != std::wstring::npos)
    throw std::runtime_error("Native source trusted image or cwd invalid");
  Handle image(CreateFileW(command.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION info{};
  if (image.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(image.value, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
    throw std::runtime_error("Native source image unavailable");
  const auto digest = hash(image.value);
  if (std::wstring(digest.begin(), digest.end()) != expected) throw std::runtime_error("Native source image hash changed");
  const DWORD count = input.integer();
  if (count > 128) throw std::runtime_error("Native source argument count invalid");
  const auto slash = command.find_last_of(L'\\');
  const bool interpreted = slash != std::wstring::npos && !_wcsicmp(command.substr(slash + 1).c_str(), L"bun.exe");
  std::wstring args = quote(command);
  for (DWORD at = 0; at < count; ++at) args += L" " + quote(input.text());
  const DWORD total = input.integer();
  if (!total || total > 64) throw std::runtime_error("Native source roots absent or oversized");
  std::string roots = "[";
  std::wstring previous;
  std::vector<std::wstring> paths;
  for (DWORD at = 0; at < total; ++at) {
    const DWORD kind = input.integer();
    auto file = input.text();
    if (kind > 1 || _wcsicmp(canonical(file).c_str(), file.c_str())) throw std::runtime_error("Native source declared root changed");
    paths.push_back(file);
    if (LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, file.data(), static_cast<int>(file.size()), file.data(), static_cast<int>(file.size()), nullptr, nullptr, 0) != static_cast<int>(file.size()))
      throw std::runtime_error("Native source root case normalization failed");
    const auto sorted = std::wstring(kind ? L"sqlite:" : L"json:") + file;
    if (!previous.empty() && previous >= sorted) throw std::runtime_error("Native source roots are not ordered and distinct");
    previous = sorted;
    if (at) roots += ",";
    roots += "{\"kind\":\"" + std::string(kind ? "sqlite" : "json") + "\",\"path\":" + json(file) + "}";
  }
  roots += "]";
  std::vector<std::wstring> directories, files;
  std::string policy;
  std::string inventory;
  if (version == 2) {
    if (input.integer() != 1) throw std::runtime_error("Native source policy version unsupported");
    const auto boundaries = [&](std::vector<std::wstring>& values, bool directory) {
      const DWORD extent = input.integer();
      if (extent > 128) throw std::runtime_error("Native source policy exceeded bound");
      std::string encoded = "[";
      for (DWORD at = 0; at < extent; ++at) {
        const auto value = lower(input.text());
        if (_wcsicmp(canonical(value).c_str(), value.c_str()) || value.size() <= 3 || (!values.empty() && values.back() >= value)) throw std::runtime_error("Native source policy path changed or duplicated");
        Handle handle(CreateFileW(value.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        if (handle.value != INVALID_HANDLE_VALUE) {
          BY_HANDLE_FILE_INFORMATION details{};
          if (!GetFileInformationByHandle(handle.value, &details) || (!!(details.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) || (!directory && details.nNumberOfLinks != 1)) throw std::runtime_error("Native source policy path type or link identity changed");
        } else if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) throw std::runtime_error("Native source policy handle unavailable");
        if (at) encoded += ",";
        encoded += json(value);
        values.push_back(value);
      }
      return encoded + "]";
    };
    const auto dirs = boundaries(directories, true);
    const auto exact = boundaries(files, false);
    if (directories.size() + files.size() > 128 || directories.empty() && files.empty()) throw std::runtime_error("Native source policy is empty or oversized");
    for (const auto& directory : directories) {
      for (const auto& other : directories) if (other != directory && inside(other, directory)) throw std::runtime_error("Native source policy directory is redundant");
      for (const auto& file : files) if (inside(directory, file)) throw std::runtime_error("Native source policy file overlaps directory");
    }
    for (const auto& file : files) for (const auto& other : files) if (other != file && (inside(other, file) || inside(file, other))) throw std::runtime_error("Native source policy files overlap");
    for (const auto& root : paths) {
      bool covered = false;
      for (const auto& directory : directories) if (inside(directory, root)) covered = true;
      for (const auto& file : files) if (!_wcsicmp(file.c_str(), root.c_str())) covered = true;
      if (!covered) throw std::runtime_error("Native source seed is outside producer policy");
    }
    policy = "{\"version\":1,\"directories\":" + dirs + ",\"files\":" + exact + "}";
    inventory = ::digest(std::vector<BYTE>(policy.begin(), policy.end()));
    if (input.text() != std::wstring(inventory.begin(), inventory.end())) throw std::runtime_error("Native source policy fingerprint changed");
  }
  if (input.offset != input.data.size() || args.size() >= 32767) throw std::runtime_error("Native source envelope trailing data");
  SecureZeroMemory(input.data.data(), input.data.size());
  Handle job(CreateJobObjectW(nullptr, nullptr));
  Handle port(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{job.value, port.value};
  if (!job.value || !port.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)))
    throw std::runtime_error("Native source job unavailable");
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  const auto duplicate = [](DWORD id) {
    HANDLE value = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(), &value, 0, TRUE, DUPLICATE_SAME_ACCESS)) throw std::runtime_error("Native source inherited standard handle unavailable");
    return value;
  };
  Handle incoming(duplicate(STD_INPUT_HANDLE)), outgoing(duplicate(STD_OUTPUT_HANDLE)), errors(duplicate(STD_ERROR_HANDLE));
  startup.hStdInput = incoming.value;
  startup.hStdOutput = outgoing.value;
  startup.hStdError = errors.value;
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(command.c_str(), args.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr, cwd.c_str(), &startup, &child))
    throw std::runtime_error("Native source suspended launch failed");
  Handle process(child.hProcess);
  Handle thread(child.hThread);
  const auto born = birth(process.value);
  bool resumed = false, forced = false, unknown = false, capture = false, brokered = false, exited = false, overflow = false;
  bool rejected = false, changed = false, complete = true;
  std::map<std::wstring, bool> refused;
  const ULONGLONG deadline = GetTickCount64() + timeout;
  std::map<DWORD, std::unique_ptr<Member>> members;
  wchar_t option[2]{};
  const bool diagnostic = GetEnvironmentVariableW(L"RAYA_SOURCE_MEMBER_DIAGNOSTICS", option, 2) == 1 && option[0] == L'1';
  Diagnostic observations;
  auto boundaries = paths;
  boundaries.insert(boundaries.end(), directories.begin(), directories.end());
  boundaries.insert(boundaries.end(), files.begin(), files.end());
  const auto header = "{\"version\":" + std::to_string(version) + ",\"token\":\"" + key + "\",\"proof\":\"windows-job\",\"pid\":" + std::to_string(child.dwProcessId) +
    ",\"birth\":\"" + std::to_string(born) + "\",\"executable\":" + json(command) + ",\"digest\":\"" + digest +
    "\",\"helper\":" + std::to_string(GetCurrentProcessId()) + ",\"helperBirth\":\"" + std::to_string(birth(GetCurrentProcess())) + "\",\"interpreted\":" + (interpreted ? "true" : "false") + ",\"roots\":" + roots + (version == 2 ? ",\"policy\":" + policy + ",\"policyInventory\":\"" + inventory + "\"" : "");
  const auto admission = [&](const std::wstring& file, DWORD action) {
    auto value = packet(file);
    if (value.integer() != 1 || value.text() != std::wstring(key.begin(), key.end()) || value.integer() != action ||
        value.integer() != child.dwProcessId || number(value.text().c_str()) != born || value.offset != value.data.size())
      throw std::runtime_error("Native source request identity changed");
  };
  const auto accept = [&](const std::wstring& file, DWORD action) {
    if (refused.contains(file)) return false;
    try { admission(file, action); return true; }
    catch (const PublicationPending&) { return false; }
    catch (const std::exception& error) {
      refused.emplace(file, true);
      unknown = true;
      rejected = true;
      write(file + L".refused", header + ",\"success\":false,\"forced\":false,\"reason\":" + json(std::wstring(error.what(), error.what() + strlen(error.what()))) + "}");
      return false;
    }
  };
  try {
    if (!AssignProcessToJobObject(job.value, process.value)) throw std::runtime_error("Native source mandatory containment failed");
    members.emplace(child.dwProcessId, std::make_unique<Member>(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child.dwProcessId)));
    if (diagnostic) observations.observe(child.dwProcessId, process.value, members);
    write(control + L".source-membership", header + ",\"state\":\"membership\",\"job\":" + std::to_string(reinterpret_cast<ULONG_PTR>(job.value)) + ",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
    write(control + L".source-launch", header + ",\"state\":\"suspended\",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
    while (true) {
      if (!exited && WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) {
        DWORD status = STILL_ACTIVE;
        if (!GetExitCodeProcess(process.value, &status) || status == STILL_ACTIVE) throw std::runtime_error("Native source root exact exit unavailable");
        write(control + L".source-root-exited", header + ",\"state\":\"root-exited\",\"code\":" + std::to_string(status) + ",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
        exited = true;
      }
      DWORD message = 0;
      ULONG_PTR completion = 0;
      LPOVERLAPPED value = nullptr;
      DWORD wait = 10;
      while (GetQueuedCompletionStatus(port.value, &message, &completion, &value, wait)) {
        wait = 0;
        if (completion != reinterpret_cast<ULONG_PTR>(job.value)) throw std::runtime_error("Native source membership identity changed");
        const DWORD id = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(value));
        if (message == JOB_OBJECT_MSG_NEW_PROCESS) {
          ++observations.notifications;
          HANDLE handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, id);
          if (!handle) {
            const auto error = GetLastError();
            if (!observations.opened) observations.first = error;
            observations.last = error;
            ++observations.opened;
            unknown = true; complete = false; continue;
          }
          const auto found = members.find(id);
          if (found != members.end()) {
            Handle held(handle);
            if (birth(handle) != found->second->born) {
              ++observations.replaced;
              unknown = true; complete = false;
            } else if (found->second->settled) ++observations.settled;
            else ++observations.duplicates;
            continue;
          }
          BOOL assigned = FALSE;
          if (!IsProcessInJob(handle, job.value, &assigned)) {
            ++observations.queried;
            CloseHandle(handle); unknown = true; complete = false; continue;
          }
          if (!assigned) {
            ++observations.unassigned;
            CloseHandle(handle); unknown = true; complete = false; continue;
          }
          if (diagnostic) observations.observe(id, handle, members);
          if (members.size() >= capacity) {
            ++observations.capacity;
            CloseHandle(handle); overflow = true; unknown = true; complete = false; continue;
          }
          members.emplace(id, std::make_unique<Member>(handle));
        }
        if (message == JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS) unknown = true;
      }
      if (GetLastError() != WAIT_TIMEOUT) throw std::runtime_error("Native source membership queue failed");
      for (const auto& [id, member] : members) { static_cast<void>(id); member->close(); }
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr))
        throw std::runtime_error("Native source membership unavailable");
      if (!accounting.ActiveProcesses) {
        for (const auto& root : paths) {
          try { if (_wcsicmp(canonical(root).c_str(), root.c_str())) { unknown = true; changed = true; } }
          catch (const std::exception&) { unknown = true; changed = true; }
        }
        for (const auto& boundary : boundaries) {
          try { if (_wcsicmp(canonical(boundary).c_str(), boundary.c_str())) { unknown = true; changed = true; } }
          catch (const std::exception&) { unknown = true; changed = true; }
        }
        if (accounting.TotalProcesses != members.size()) { ++observations.accounting; unknown = true; complete = false; }
        const ULONGLONG finish = GetTickCount64() + 10000;
        if (WaitForSingleObject(process.value, 10000) != WAIT_OBJECT_0) throw std::runtime_error("Native source root final handle did not settle");
        DWORD code = STILL_ACTIVE;
        if (!GetExitCodeProcess(process.value, &code) || code == STILL_ACTIVE) throw std::runtime_error("Native source exact root exit unavailable");
        if (!exited) {
          write(control + L".source-root-exited", header + ",\"state\":\"root-exited\",\"code\":" + std::to_string(code) + ",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
          exited = true;
        }
        std::string descendants = "[";
        for (const auto& [id, member] : members) {
          const ULONGLONG remaining = finish > GetTickCount64() ? finish - GetTickCount64() : 0;
          if (!member->close(static_cast<DWORD>(remaining))) { ++observations.unsettled; unknown = true; complete = false; }
          const auto status = member->code;
          if (capture && status != 0) unknown = true;
          if (descendants.size() > 1) descendants += ",";
          descendants += "{\"pid\":" + std::to_string(id) + ",\"birth\":\"" + std::to_string(member->born) + "\",\"code\":" + std::to_string(status) + "}";
        }
        descendants += "]";
        const bool success = resumed && code == 0 && !forced && !unknown;
        write(control + L".source-retired", header + ",\"state\":\"retired\",\"rootExit\":" + std::to_string(code) +
          ",\"empty\":true,\"capture\":" + (capture ? "true" : "false") + ",\"forced\":" + (forced ? "true" : "false") +
          ",\"uncertain\":" + (unknown ? "true" : "false") + ",\"success\":" + (success ? "true" : "false") +
          ",\"members\":" + descendants + ",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
        // Producer v2 binds its physical boundary before execution. Kernel Job zero
        // settles ordinary retirement even when transient member handles were missed;
        // the legacy diagnostic receipt above deliberately remains strict.
        const bool zero = resumed && (capture || version == 2) && code == 0 && !forced && !rejected && !changed;
        const auto family = "{\"version\":" + std::to_string(version + 1) + header.substr(std::string("{\"version\":1").size());
        write(control + L".source-family-retired", family + ",\"state\":\"retired\",\"rootExit\":" + std::to_string(code) +
          ",\"familyZeroObserved\":true,\"sealed\":true,\"capture\":" + (capture ? "true" : "false") + ",\"forced\":" + (forced ? "true" : "false") +
          ",\"memberObservationsComplete\":" + (complete ? "true" : "false") + ",\"totalProcesses\":" + std::to_string(accounting.TotalProcesses) +
          ",\"memberObservationsOverflow\":" + (overflow ? "true" : "false") +
          ",\"success\":" + (zero ? "true" : "false") + ",\"members\":" + descendants + ",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
        if (diagnostic) {
          observations.measure(members.size());
          try { write(control + L".source-members-diagnostic", observations.report()); }
          catch (const std::exception&) { std::fputs("Native member diagnostic publication failed\n", stderr); }
        }
        return (capture || version == 2 ? zero : success) ? 0 : 1;
      }
      if (!capture && exists(control + L".source-capture") && accept(control + L".source-capture", 2)) {
        capture = true;
        write(control + L".source-capture-ready", header + ",\"state\":\"capture-ready\",\"completeProfileCoverage\":false,\"portableCaptureAuthorized\":false}");
      }
      if (!forced && exists(control + L".source-abort") && accept(control + L".source-abort", 3)) { if (!TerminateJobObject(job.value, 1)) throw std::runtime_error("Native source explicit abort failed"); forced = true; }
      if (!resumed && !forced && exists(control + L".source-go")) {
        if (accept(control + L".source-go", 1)) {
          if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) throw std::runtime_error("Native source resume failed");
          resumed = true;
        }
      }
      if (!resumed && !forced && GetTickCount64() >= deadline) { if (!TerminateJobObject(job.value, 1)) throw std::runtime_error("Native source admission timeout failed"); forced = true; }
      if (!brokered && !refused.contains(control + L".source-broker") && exists(control + L".source-broker")) {
        try {
        if (capture || forced) throw std::runtime_error("Native source broker intake is closed");
        auto request = packet(control + L".source-broker");
        if (request.integer() != 1 || request.text() != std::wstring(key.begin(), key.end())) throw std::runtime_error("Native source broker identity changed");
        const auto nonce = request.text();
        if (nonce.size() != 36 || nonce.find_first_not_of(L"0123456789abcdef-") != std::wstring::npos) throw std::runtime_error("Native source broker request invalid");
        const auto executable = request.text();
        const auto directory = request.text();
        if (_wcsicmp(executable.c_str(), command.c_str()) || _wcsicmp(canonical(directory).c_str(), directory.c_str())) throw std::runtime_error("Native source broker trusted target changed");
        for (const auto& root : boundaries) {
          if (!_wcsnicmp(directory.c_str(), root.c_str(), root.size()) && (directory.size() == root.size() || directory[root.size()] == L'\\')) throw std::runtime_error("Native source broker directory overlaps source root");
          if (!_wcsnicmp(root.c_str(), directory.c_str(), directory.size()) && (root.size() == directory.size() || root[directory.size()] == L'\\')) throw std::runtime_error("Native source broker directory contains source root");
        }
        std::wstring arguments = quote(executable);
        const auto argc = request.integer();
        if (!argc || argc > 128) throw std::runtime_error("Native source broker arguments invalid");
        std::vector<std::wstring> argv;
        for (DWORD at = 0; at < argc; ++at) { argv.push_back(request.text()); arguments += L" " + quote(argv.back()); }
        if (!interpreted && (argv.size() != 1 || argv[0] != L"__profile-source-successor")) throw std::runtime_error("Native source broker route is not the pinned successor");
        if (interpreted && (argv.size() != 1 || argv[0].size() < 4 || argv[0].substr(argv[0].size() - 3) != L".ts" || _wcsicmp(canonical(argv[0]).c_str(), argv[0].c_str()) || _wcsnicmp(argv[0].c_str(), directory.c_str(), directory.size()) || argv[0][directory.size()] != L'\\'))
          throw std::runtime_error("Native source interpreted broker fixture must reside in its isolated directory");
        const auto envc = request.integer();
        if (!envc || envc > 256) throw std::runtime_error("Native source broker environment invalid");
        std::vector<std::wstring> entries;
        std::map<std::wstring, std::wstring> env;
        for (DWORD at = 0; at < envc; ++at) {
          const auto name = request.text();
          const auto content = request.text();
          if (name.empty() || name.find(L'=') != std::wstring::npos) throw std::runtime_error("Native source broker environment key invalid");
          std::wstring lower = name;
          if (LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, lower.data(), static_cast<int>(lower.size()), lower.data(), static_cast<int>(lower.size()), nullptr, nullptr, 0) != static_cast<int>(lower.size()) || !env.emplace(lower, content).second)
            throw std::runtime_error("Native source broker environment has duplicate keys");
          const std::vector<std::wstring> allowed{L"home", L"userprofile", L"kilo_test_home", L"xdg_data_home", L"xdg_config_home", L"xdg_cache_home", L"xdg_state_home", L"kilo_db", L"raya_db", L"path", L"systemroot", L"temp", L"tmp", L"localappdata", L"raya_source_handoff_control", L"raya_source_handoff_channel", L"raya_source_handoff_pipe", L"kilo_auth_content", L"raya_auth_content"};
          if (std::find(allowed.begin(), allowed.end(), lower) == allowed.end() && !(interpreted && lower == L"raya_source_job_test_root")) throw std::runtime_error("Native source broker environment key is not admitted");
          if ((lower == L"raya_auth_content" || lower == L"kilo_auth_content") && content != L"{}") throw std::runtime_error("Native source broker cannot inherit credentials");
          entries.push_back(name + L"=" + content);
        }
        for (const auto name : {L"home", L"userprofile", L"xdg_data_home", L"xdg_config_home", L"xdg_cache_home", L"xdg_state_home", L"kilo_db", L"raya_db"}) {
          const auto found = env.find(name);
          if (found == env.end() || _wcsicmp(canonical(found->second).c_str(), found->second.c_str())) throw std::runtime_error("Native source broker private root missing or changed");
          for (const auto& root : boundaries) {
            if (!_wcsnicmp(found->second.c_str(), root.c_str(), root.size()) && (found->second.size() == root.size() || found->second[root.size()] == L'\\')) throw std::runtime_error("Native source broker environment overlaps source root");
            if (!_wcsnicmp(root.c_str(), found->second.c_str(), found->second.size()) && (root.size() == found->second.size() || root[found->second.size()] == L'\\')) throw std::runtime_error("Native source broker environment contains source root");
          }
        }
        if (_wcsicmp(env.at(L"home").c_str(), directory.c_str()) || _wcsicmp(env.at(L"userprofile").c_str(), directory.c_str()) || _wcsicmp(env.at(L"kilo_db").c_str(), env.at(L"raya_db").c_str()))
          throw std::runtime_error("Native source broker private profile differs from declared cwd");
        for (const auto name : {L"temp", L"tmp", L"kilo_test_home", L"raya_source_handoff_control"}) {
          const auto found = env.find(name);
          if (found == env.end()) continue;
          if (_wcsicmp(canonical(found->second).c_str(), found->second.c_str())) throw std::runtime_error("Native source broker auxiliary root changed");
          for (const auto& root : boundaries) {
            if (!_wcsnicmp(found->second.c_str(), root.c_str(), root.size()) && (found->second.size() == root.size() || found->second[root.size()] == L'\\')) throw std::runtime_error("Native source broker auxiliary root overlaps source root");
            if (!_wcsnicmp(root.c_str(), found->second.c_str(), found->second.size()) && (root.size() == found->second.size() || root[found->second.size()] == L'\\')) throw std::runtime_error("Native source broker auxiliary root contains source root");
          }
        }
        if (request.offset != request.data.size() || arguments.size() >= 32767) throw std::runtime_error("Native source broker trailing data");
        std::sort(entries.begin(), entries.end());
        std::vector<wchar_t> environment;
        for (const auto& entry : entries) { environment.insert(environment.end(), entry.begin(), entry.end()); environment.push_back(0); }
        environment.push_back(0);
        Handle null(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
        STARTUPINFOW opts{};
        opts.cb = sizeof(opts);
        opts.dwFlags = STARTF_USESTDHANDLES;
        opts.hStdInput = null.value; opts.hStdOutput = null.value; opts.hStdError = null.value;
        PROCESS_INFORMATION successor{};
        if (!CreateProcessW(executable.c_str(), arguments.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environment.data(), directory.c_str(), &opts, &successor))
          throw std::runtime_error("Native source outside-job broker launch failed");
        Handle target(successor.hProcess);
        Handle task(successor.hThread);
        try {
        BOOL assigned = TRUE;
        if (!IsProcessInJob(target.value, job.value, &assigned) || assigned) throw std::runtime_error("Native source broker belongs to captured job");
        write(control + L".source-broker-launched", "{\"version\":1,\"token\":\"" + key + "\",\"request\":" + json(nonce) +
          ",\"pid\":" + std::to_string(successor.dwProcessId) + ",\"birth\":\"" + std::to_string(birth(target.value)) + "\",\"outsideJob\":true}");
        if (ResumeThread(task.value) == static_cast<DWORD>(-1)) throw std::runtime_error("Native source broker resume failed");
        brokered = true;
        } catch (...) {
          const bool stopped = TerminateProcess(target.value, 1) && WaitForSingleObject(target.value, 30000) == WAIT_OBJECT_0;
          write(control + L".source-broker-uncertain", header + ",\"success\":false,\"forced\":true,\"pid\":" + std::to_string(successor.dwProcessId) + ",\"birth\":\"" + std::to_string(birth(target.value)) + "\",\"absent\":" + (stopped ? "true" : "false") + "}");
          throw;
        }
        } catch (const PublicationPending&) {
          Sleep(1); // An atomic move's still-held DELETE handle has not completed publication.
        } catch (const std::exception& error) {
          refused.emplace(control + L".source-broker", true);
          unknown = true;
          rejected = true;
          write(control + L".source-broker.refused", header + ",\"success\":false,\"forced\":false,\"reason\":" + json(std::wstring(error.what(), error.what() + strlen(error.what()))) + "}");
        }
      }
    }
  } catch (...) {
    TerminateJobObject(job.value, 1);
    write(control + L".source-uncertain", header + ",\"forced\":true,\"success\":false,\"portableCaptureAuthorized\":false}");
    throw;
  }
}
}
