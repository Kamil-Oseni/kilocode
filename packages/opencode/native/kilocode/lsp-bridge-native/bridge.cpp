#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <bcrypt.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#include <array>
#include <algorithm>
#include <stdexcept>

// Source-only draft: not compiled, packaged, connected or accepted.
namespace Lsp {
struct Error : std::exception {
  const char* phase;
  DWORD code;
  Error(const char* name, DWORD value = GetLastError()) : phase(name), code(value) {}
  const char* what() const noexcept override { return phase; }
};

bool same(const std::wstring& a, const std::wstring& b) {
  return CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}

std::wstring wide(const BYTE* bytes, size_t length) {
  if (!length) return L"";
  const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes), static_cast<int>(length), nullptr, 0);
  if (!count) throw Error("frame UTF8");
  std::wstring text(static_cast<size_t>(count), 0);
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes), static_cast<int>(length), text.data(), count) != count || text.find(L'\0') != std::wstring::npos) throw Error("frame string", ERROR_INVALID_DATA);
  return text;
}

std::string utf8(const std::wstring& text) {
  const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!count && !text.empty()) throw Error("control UTF8");
  std::string bytes(static_cast<size_t>(count), 0);
  if (count && WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), bytes.data(), count, nullptr, nullptr) != count) throw Error("control UTF8");
  return bytes;
}

std::string json(const std::wstring& text) {
  const auto bytes = utf8(text);
  std::string result = "\"";
  const char* hex = "0123456789abcdef";
  for (const unsigned char c : bytes) {
    if (c == '\\' || c == '"') { result += '\\'; result += static_cast<char>(c); }
    else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
    else result += static_cast<char>(c);
  }
  return result + "\"";
}

std::wstring path(const std::wstring& value) {
  if (value.size() < 3 || value.size() > 4096 || value[1] != L':' || value[2] != L'\\' || value.find(L'/') != std::wstring::npos || value.find(L':', 2) != std::wstring::npos) throw Error("canonical DOS path", ERROR_INVALID_DATA);
  wchar_t full[4101]{};
  const auto count = GetFullPathNameW(value.c_str(), 4101, full, nullptr);
  if (!count || count >= 4101 || !same(full, value)) throw Error("canonical DOS path", ERROR_INVALID_DATA);
  return value;
}

struct Envelope {
  std::wstring token, target, digest, cwd;
  std::vector<std::wstring> args;
  std::vector<std::pair<std::wstring, std::wstring>> env;
};

struct Frame {
  std::vector<BYTE> bytes;
  size_t offset = 0;
  static void exact(HANDLE input, BYTE* data, DWORD length) {
    DWORD offset = 0;
    while (offset < length) {
      DWORD count = 0;
      if (!ReadFile(input, data + offset, length - offset, &count, nullptr)) throw Error("frame read");
      if (!count) throw Error("frame incomplete", ERROR_HANDLE_EOF);
      offset += count;
    }
  }
  uint32_t number() {
    if (bytes.size() - offset < 4) throw Error("frame integer", ERROR_INVALID_DATA);
    const auto value = static_cast<uint32_t>(bytes[offset]) | (static_cast<uint32_t>(bytes[offset + 1]) << 8) | (static_cast<uint32_t>(bytes[offset + 2]) << 16) | (static_cast<uint32_t>(bytes[offset + 3]) << 24);
    offset += 4;
    return value;
  }
  std::wstring text(size_t maximum) {
    const auto length = number();
    if (length > maximum || length > bytes.size() - offset) throw Error("frame string bound", ERROR_INVALID_DATA);
    const auto value = wide(bytes.data() + offset, length);
    offset += length;
    return value;
  }
  static Envelope read(HANDLE input) {
    BYTE prefix[4]{};
    exact(input, prefix, 4);
    const auto length = static_cast<uint32_t>(prefix[0]) | (static_cast<uint32_t>(prefix[1]) << 8) | (static_cast<uint32_t>(prefix[2]) << 16) | (static_cast<uint32_t>(prefix[3]) << 24);
    if (!length || length > 65536) throw Error("frame bound", ERROR_INVALID_DATA);
    Frame frame;
    frame.bytes.resize(length);
    exact(input, frame.bytes.data(), length);
    if (frame.number() != 0x31424c52 || frame.number() != 1) throw Error("frame magic/version", ERROR_INVALID_DATA);
    Envelope value;
    value.token = frame.text(32);
    value.digest = frame.text(64);
    const auto hex = [](const std::wstring& text, size_t length) {
      return text.size() == length && std::all_of(text.begin(), text.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
    };
    if (!hex(value.token, 32) || !hex(value.digest, 64)) throw Error("frame token/digest", ERROR_INVALID_DATA);
    value.target = path(frame.text(16384));
    value.cwd = path(frame.text(16384));
    const auto argc = frame.number();
    if (argc > 128) throw Error("frame argument count", ERROR_INVALID_DATA);
    for (uint32_t index = 0; index < argc; index++) value.args.push_back(frame.text(8192));
    const auto count = frame.number();
    if (count > 128) throw Error("frame environment count", ERROR_INVALID_DATA);
    size_t size = 2;
    for (uint32_t index = 0; index < count; index++) {
      const auto key = frame.text(128);
      const auto text = frame.text(8192);
      if (key.empty() || key.find(L'=') != std::wstring::npos || std::any_of(value.env.begin(), value.env.end(), [&](const auto& row) { return same(key, row.first); })) throw Error("frame environment key", ERROR_INVALID_DATA);
      size += (key.size() + text.size() + 2) * sizeof(wchar_t);
      if (size > 65536) throw Error("frame environment bound", ERROR_INVALID_DATA);
      value.env.emplace_back(key, text);
    }
    if (frame.offset != frame.bytes.size()) throw Error("frame trailing bytes", ERROR_INVALID_DATA);
    return value;
  }
};

struct Failure { const char* phase = nullptr; DWORD code = 0; };
struct Ledger {
  CRITICAL_SECTION lock{};
  std::array<Failure, 64> rows{};
  size_t count = 0;
  bool overflow = false;
  Ledger() { InitializeCriticalSection(&lock); }
  ~Ledger() { DeleteCriticalSection(&lock); }
  void add(const char* phase, DWORD code) noexcept {
    EnterCriticalSection(&lock);
    if (count < rows.size()) rows[count++] = {phase, code};
    else overflow = true;
    LeaveCriticalSection(&lock);
  }
};

struct Pump {
  HANDLE read = nullptr;
  HANDLE write = nullptr;
  HANDLE thread = nullptr;
  bool input = false;
  bool joined = false;
  bool eof = false;
  volatile LONG terminal = 0;
  Ledger* ledger = nullptr;
  static DWORD WINAPI run(void* raw) noexcept {
    auto& pump = *static_cast<Pump*>(raw);
    BYTE bytes[65536]{};
    bool forward = true;
    while (!pump.input || InterlockedCompareExchange(&pump.terminal, 0, 0) == 0) {
      DWORD count = 0;
      if (!ReadFile(pump.read, bytes, static_cast<DWORD>(sizeof(bytes)), &count, nullptr)) {
        const auto error = GetLastError();
        const auto requested = pump.input && InterlockedCompareExchange(&pump.terminal, 0, 0) != 0;
        if (error == ERROR_BROKEN_PIPE) pump.eof = true;
        if (error != ERROR_BROKEN_PIPE && !(requested && error == ERROR_OPERATION_ABORTED)) pump.ledger->add(pump.input ? "input read" : "output read", error);
        break;
      }
      if (!count) { pump.eof = true; break; }
      if (pump.input && InterlockedCompareExchange(&pump.terminal, 0, 0) != 0) break;
      DWORD offset = 0;
      while (forward && offset < count && (!pump.input || InterlockedCompareExchange(&pump.terminal, 0, 0) == 0)) {
        DWORD written = 0;
        if (!WriteFile(pump.write, bytes + offset, count - offset, &written, nullptr)) {
          const auto error = GetLastError();
          const auto requested = pump.input && InterlockedCompareExchange(&pump.terminal, 0, 0) != 0;
          if (!(pump.input && error == ERROR_BROKEN_PIPE) && !(requested && error == ERROR_OPERATION_ABORTED)) pump.ledger->add(pump.input ? "input write" : "output forwarding", error);
          forward = false;
          break;
        }
        if (!written) { pump.ledger->add("zero forwarding", ERROR_WRITE_FAULT); forward = false; break; }
        offset += written;
      }
      if (pump.input && !forward) break;
      // A broken parent sink does not cancel or stop the native output reader.
    }
    if (pump.input) {
      // This exact writer is owned exclusively by this original input thread.
      // EOF must reach the target before waiting for its exit.
      while (pump.write && !CloseHandle(pump.write)) { pump.ledger->add("input writer close", GetLastError()); Sleep(100); }
      pump.write = nullptr;
    }
    return 0;
  }
  void start() {
    thread = CreateThread(nullptr, 0, run, this, 0, nullptr);
    if (!thread) throw Error("pump create");
  }
  void stop() noexcept {
    if (!input || !thread) return;
    InterlockedExchange(&terminal, 1);
    if (!CancelSynchronousIo(thread)) {
      const auto error = GetLastError();
      if (error != ERROR_NOT_FOUND) ledger->add("input cancellation", error);
    }
  }
  void join() {
    if (!thread) return;
    while (true) {
      const auto result = WaitForSingleObject(thread, input ? 50 : INFINITE);
      if (result == WAIT_OBJECT_0) break;
      if (result != WAIT_TIMEOUT) throw Error("pump original join");
      if (InterlockedCompareExchange(&terminal, 0, 0) != 0) stop();
    }
    joined = true;
  }
  void unopened() noexcept {
    if (!input || thread || !write) return;
    while (!CloseHandle(write)) { ledger->add("unstarted input close", GetLastError()); Sleep(100); }
    write = nullptr;
  }
  void release() noexcept {
    if (!thread) return;
    while (!CloseHandle(thread)) { ledger->add("pump handle close", GetLastError()); Sleep(100); }
    thread = nullptr;
  }
};

struct Keeper {
  Ledger ledger;
  std::array<HANDLE, 512> handles{};
  std::array<HANDLE, 384> ancestry{};
  size_t count = 0;
  size_t paths = 0;
  HANDLE job = nullptr;
  std::array<HANDLE, 3> ends{};
  std::array<Pump, 3> pumps{};
  PROCESS_INFORMATION process{};
  bool created = false;
  bool resumed = false;
  bool zero = false;
  DWORD code = 0;
  uint64_t birth = 0;
  std::wstring image;
  HANDLE retain(HANDLE handle) {
    if (!handle || handle == INVALID_HANDLE_VALUE) throw Error("handle create");
    if (count == handles.size()) { CloseHandle(handle); throw Error("handle bound", ERROR_INVALID_DATA); }
    handles[count++] = handle;
    return handle;
  }
  void drop(HANDLE handle) noexcept {
    if (!handle) return;
    for (size_t index = 0; index < count; index++) {
      if (handles[index] != handle) continue;
      while (!CloseHandle(handle)) { ledger.add("handle close", GetLastError()); Sleep(100); }
      handles[index] = nullptr;
      return;
    }
  }
  bool pinned(HANDLE handle) const {
    return std::find(ancestry.begin(), ancestry.begin() + paths, handle) != ancestry.begin() + paths;
  }
  HANDLE pin(const std::wstring& selected, bool directory) {
    const auto value = path(selected);
    std::vector<std::wstring> parts;
    for (size_t index = 3; index < value.size(); index++) if (value[index] == L'\\') parts.push_back(value.substr(0, index));
    parts.insert(parts.begin(), value.substr(0, 3));
    if (value.size() > 3) parts.push_back(value);
    if (parts.size() > 128 || paths + parts.size() > ancestry.size()) throw Error("ancestry bound", ERROR_INVALID_DATA);
    HANDLE leaf = nullptr;
    for (size_t index = 0; index < parts.size(); index++) {
      const auto file = !directory && index == parts.size() - 1;
      // No delete sharing pins namespace. The actual image additionally denies writes.
      leaf = retain(CreateFileW(parts[index].c_str(), file ? GENERIC_READ : FILE_READ_ATTRIBUTES, file ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      BY_HANDLE_FILE_INFORMATION info{};
      if (!GetFileInformationByHandle(leaf, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || (!!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == file) || (file && info.nNumberOfLinks != 1)) throw Error("ordinary path identity", ERROR_INVALID_DATA);
      wchar_t physical[4101]{};
      const auto length = GetFinalPathNameByHandleW(leaf, physical, 4101, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
      auto expected = parts[index];
      if (expected.size() == 3) expected.pop_back();
      auto actual = std::wstring(physical);
      if (actual.size() > 4 && actual.substr(0, 4) == L"\\\\?\\") actual.erase(0, 4);
      if (actual.size() == 3 && actual.back() == L'\\') actual.pop_back();
      if (!length || length >= 4101 || !same(expected, actual)) throw Error("path alias", ERROR_INVALID_DATA);
      ancestry[paths++] = leaf;
    }
    return leaf;
  }
  std::wstring hash(HANDLE file) {
    LARGE_INTEGER length{};
    if (!GetFileSizeEx(file, &length) || length.QuadPart < 0 || length.QuadPart > 256LL * 1024 * 1024) throw Error("image size", ERROR_INVALID_DATA);
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE state = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) throw Error("image algorithm", ERROR_INVALID_DATA);
    DWORD size = 0, returned = 0;
    std::array<BYTE, 32> digest{};
    std::vector<BYTE> object;
    const auto close = [&]() {
      // The hash still owns this function's backing object until destroy succeeds.
      // A caller observation deadline cannot free it after a failed destroy.
      while (state) {
        const auto status = BCryptDestroyHash(state);
        if (status >= 0) { state = nullptr; break; }
        ledger.add("hash close", static_cast<DWORD>(status));
        Sleep(100);
      }
      while (algorithm) {
        const auto status = BCryptCloseAlgorithmProvider(algorithm, 0);
        if (status >= 0) { algorithm = nullptr; break; }
        ledger.add("algorithm close", static_cast<DWORD>(status));
        Sleep(100);
      }
    };
    try {
      if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<BYTE*>(&size), static_cast<ULONG>(sizeof(size)), &returned, 0) < 0 || size > 65536) throw Error("image hash size", ERROR_INVALID_DATA);
      object.resize(size);
      if (BCryptCreateHash(algorithm, &state, object.data(), size, nullptr, 0, 0) < 0) throw Error("image hash create", ERROR_INVALID_DATA);
      BYTE buffer[65536]{};
      while (true) {
        DWORD read = 0;
        if (!ReadFile(file, buffer, static_cast<DWORD>(sizeof(buffer)), &read, nullptr)) throw Error("image read");
        if (!read) break;
        if (BCryptHashData(state, buffer, read, 0) < 0) throw Error("image hash data", ERROR_INVALID_DATA);
      }
      if (BCryptFinishHash(state, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) throw Error("image hash finish", ERROR_INVALID_DATA);
      std::wstring value;
      for (const auto byte : digest) { value += L"0123456789abcdef"[byte >> 4]; value += L"0123456789abcdef"[byte & 15]; }
      close();
      return value;
    } catch (...) { close(); throw; }
  }
  static std::wstring quote(const std::wstring& value) {
    std::wstring text = L"\"";
    size_t slashes = 0;
    for (const auto chr : value) {
      if (chr == L'\\') { slashes++; continue; }
      text.append(chr == L'"' ? slashes * 2 + 1 : slashes, L'\\');
      text += chr;
      slashes = 0;
    }
    text.append(slashes * 2, L'\\');
    return text + L"\"";
  }
  void pipe(HANDLE& read, HANDLE& write) {
    SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
    if (!CreatePipe(&read, &write, &security, 0)) throw Error("pipe create");
    retain(read); retain(write);
  }
  static void empty(const std::wstring& root) {
    WIN32_FIND_DATAW data{};
    const auto search = FindFirstFileW((root + L"\\*").c_str(), &data);
    if (search == INVALID_HANDLE_VALUE) throw Error("control inventory");
    bool other = false;
    do { if (wcscmp(data.cFileName, L".") && wcscmp(data.cFileName, L"..")) other = true; } while (FindNextFileW(search, &data));
    const auto error = GetLastError();
    const auto closed = FindClose(search);
    if (!closed || error != ERROR_NO_MORE_FILES || other) throw Error("fresh control required", ERROR_INVALID_DATA);
  }
  void resume() {
    if (!created || resumed) return;
    if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) throw Error("target resume");
    resumed = true;
  }
  void start(const Envelope& value, const std::wstring& control) {
    pin(control, true);
    empty(control);
    pin(value.cwd, true);
    const auto executable = pin(value.target, false);
    if (hash(executable) != value.digest) throw Error("target hash", ERROR_INVALID_DATA);
    if (ledger.count) throw Error("pre-create cleanup", ERROR_INVALID_DATA);
    job = retain(CreateJobObjectW(nullptr, nullptr));
    HANDLE input = nullptr, output = nullptr, error = nullptr;
    pipe(ends[0], input); pipe(output, ends[1]); pipe(error, ends[2]);
    for (const auto handle : {input, output, error}) if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)) throw Error("pipe inheritance");
    pumps[0].read = GetStdHandle(STD_INPUT_HANDLE); pumps[0].write = input; pumps[0].input = true;
    pumps[1].read = output; pumps[1].write = GetStdHandle(STD_OUTPUT_HANDLE);
    pumps[2].read = error; pumps[2].write = GetStdHandle(STD_ERROR_HANDLE);
    for (auto& pump : pumps) pump.ledger = &ledger;
    // Transfer before starting: the input thread may observe EOF and close its
    // writer immediately. A later thread creation may reuse that numeric handle.
    for (size_t index = 0; index < count; index++) if (handles[index] == input) handles[index] = nullptr;
    for (auto& pump : pumps) pump.start();
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    if (!size || size > 65536) throw Error("attribute size", ERROR_INVALID_DATA);
    std::vector<BYTE> buffer(size);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer.data());
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) throw Error("attribute create");
    const auto clear = [&]() { DeleteProcThreadAttributeList(attributes); };
    try {
      const HANDLE inherited[]{ends[0], ends[1], ends[2]};
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, const_cast<HANDLE*>(inherited), sizeof(inherited), nullptr, nullptr) || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr)) throw Error("creation attributes");
      auto command = quote(value.target);
      for (const auto& arg : value.args) command += L" " + quote(arg);
      if (command.size() > 32766) throw Error("command bound", ERROR_INVALID_DATA);
      auto sorted = value.env;
      std::sort(sorted.begin(), sorted.end(), [](const auto& a, const auto& b) { return CompareStringOrdinal(a.first.c_str(), -1, b.first.c_str(), -1, TRUE) == CSTR_LESS_THAN; });
      std::wstring env;
      for (const auto& row : sorted) { env += row.first + L"=" + row.second; env += L'\0'; }
      env += L'\0'; if (sorted.empty()) env += L'\0';
      STARTUPINFOEXW startup{};
      startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.StartupInfo.hStdInput = ends[0]; startup.StartupInfo.hStdOutput = ends[1]; startup.StartupInfo.hStdError = ends[2];
      startup.lpAttributeList = attributes;
      if (count + 2 > handles.size()) throw Error("process handle reserve", ERROR_INVALID_DATA);
      if (!CreateProcessW(value.target.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env.data(), value.cwd.c_str(), &startup.StartupInfo, &process)) throw Error("target create");
      // The keeper already exists; installing original handles cannot allocate/throw.
      created = true;
      handles[count++] = process.hProcess; handles[count++] = process.hThread;
      for (const auto handle : ends) drop(handle);
      FILETIME time{}, exit{}, kernel{}, user{};
      if (!GetProcessTimes(process.hProcess, &time, &exit, &kernel, &user)) throw Error("target birth");
      birth = (static_cast<uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
      wchar_t actual[4101]{}; DWORD capacity = 4101;
      if (!QueryFullProcessImageNameW(process.hProcess, 0, actual, &capacity)) throw Error("target image");
      image = path(actual);
      if (!same(image, value.target)) throw Error("created image mismatch", ERROR_INVALID_DATA);
      resume();
      publish(control, L"launch.json", "{\"format\":\"raya.lsp.bridge.launch\",\"version\":1,\"token\":" + json(value.token) + ",\"pid\":" + std::to_string(process.dwProcessId) + ",\"birth\":\"" + std::to_string(birth) + "\",\"bridge\":" + std::to_string(GetCurrentProcessId()) + ",\"executable\":" + json(image) + ",\"digest\":" + json(value.digest) + ",\"creationJob\":true,\"fullMembersObserved\":false}");
      clear();
    } catch (...) { clear(); throw; }
  }
  void retire() {
    if (created) {
      while (!resumed) { try { resume(); } catch (const Error& error) { ledger.add(error.phase, error.code); Sleep(100); } }
      if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) throw Error("original root wait");
      pumps[0].stop();
      if (!GetExitCodeProcess(process.hProcess, &code)) throw Error("original exit code");
      if (code) ledger.add("target nonzero", code);
    } else {
      pumps[0].stop();
      for (const auto handle : ends) drop(handle);
    }
    pumps[0].unopened();
    pumps[0].join();
    if (created) {
      while (!zero) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, static_cast<DWORD>(sizeof(info)), nullptr)) { ledger.add("job query", GetLastError()); Sleep(100); continue; }
        zero = info.ActiveProcesses == 0;
        if (!zero) Sleep(50);
      }
    }
    for (auto& pump : pumps) pump.join();
    for (auto& pump : pumps) pump.release();
    for (size_t index = 0; index < count; index++) if (handles[index] && !pinned(handles[index])) drop(handles[index]);
  }
  void release() noexcept {
    for (size_t index = 0; index < count; index++) if (handles[index]) drop(handles[index]);
  }
  std::string result(const Envelope& value) {
    std::string rows = "[";
    for (size_t index = 0; index < ledger.count; index++) {
      if (index) rows += ",";
      rows += "{\"phase\":\"" + std::string(ledger.rows[index].phase) + "\",\"code\":" + std::to_string(ledger.rows[index].code) + "}";
    }
    rows += "]";
    return "{\"format\":\"raya.lsp.bridge.result\",\"version\":1,\"token\":" + json(value.token) + ",\"pid\":" + std::to_string(process.dwProcessId) + ",\"birth\":\"" + std::to_string(birth) + "\",\"executable\":" + json(image) + ",\"digest\":" + json(value.digest) + ",\"created\":" + (created ? "true" : "false") + ",\"rootExit\":" + (created ? std::to_string(code) : "null") + ",\"jobZero\":" + (zero ? "true" : "false") + ",\"inputJoined\":" + (pumps[0].joined ? "true" : "false") + ",\"outputJoined\":" + (pumps[1].joined && pumps[2].joined ? "true" : "false") + ",\"stdoutEOF\":" + (pumps[1].eof ? "true" : "false") + ",\"stderrEOF\":" + (pumps[2].eof ? "true" : "false") + ",\"forced\":false,\"fullMembersObserved\":false,\"failureOverflow\":" + (ledger.overflow ? "true" : "false") + ",\"failures\":" + rows + "}";
  }
  static void publish(const std::wstring& directory, const wchar_t* name, const std::string& bytes) {
    if (bytes.size() > 16384) throw Error("control bound", ERROR_INVALID_DATA);
    const auto file = CreateFileW((directory + L"\\" + name).c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw Error("control create");
    DWORD offset = 0;
    DWORD failure = 0;
    while (offset < bytes.size()) {
      DWORD written = 0;
      if (!WriteFile(file, bytes.data() + offset, static_cast<DWORD>(bytes.size()) - offset, &written, nullptr) || !written) { failure = GetLastError(); if (!failure) failure = ERROR_WRITE_FAULT; break; }
      offset += written;
    }
    if (!failure && !FlushFileBuffers(file)) failure = GetLastError();
    while (!CloseHandle(file)) { if (!failure) failure = GetLastError(); Sleep(100); }
    if (failure) throw Error("control publication", failure);
  }
};
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 3 || wcscmp(argv[1], L"--control")) return 2;
  Lsp::Keeper keeper;
  Lsp::Envelope value;
  std::wstring control;
  bool parsed = false;
  try {
    control = Lsp::path(argv[2]);
    for (const auto kind : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) if (GetFileType(GetStdHandle(kind)) != FILE_TYPE_PIPE) throw Lsp::Error("three private pipes required", ERROR_INVALID_DATA);
    value = Lsp::Frame::read(GetStdHandle(STD_INPUT_HANDLE));
    parsed = true;
    keeper.start(value, control);
  } catch (const Lsp::Error& error) { keeper.ledger.add(error.phase, error.code); }
    catch (...) { keeper.ledger.add("bootstrap exception", ERROR_UNHANDLED_EXCEPTION); }
  try { keeper.retire(); }
  catch (const Lsp::Error& error) {
    keeper.ledger.add(error.phase, error.code);
    // No destructor or deadline may close a potentially live original owner.
    while (true) Sleep(1000);
  } catch (...) {
    keeper.ledger.add("retirement exception", ERROR_UNHANDLED_EXCEPTION);
    while (true) Sleep(1000);
  }
  if (parsed) {
    try { Lsp::Keeper::publish(control, L"result.json", keeper.result(value)); }
    catch (const Lsp::Error& error) { keeper.ledger.add(error.phase, error.code); }
    catch (...) { keeper.ledger.add("result exception", ERROR_UNHANDLED_EXCEPTION); }
  }
  // Result precedes namespace release. Later failures are reflected by the held
  // bridge's nonzero exit, not a claim that result contains every finalizer error.
  keeper.release();
  return keeper.ledger.count ? 1 : 0;
}
