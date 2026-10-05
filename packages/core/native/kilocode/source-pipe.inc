#include <sddl.h>

// Secrets cross stdin and this private local pipe only. The pipe payload is not
// an authority receipt; both peers hold and verify exact Windows identities.
namespace SourcePipe {
struct Memory {
  std::vector<BYTE> data;
  ~Memory() { if (!data.empty()) SecureZeroMemory(data.data(), data.size()); }
};

void read(HANDLE handle, void* value, DWORD size) {
  DWORD offset = 0;
  while (offset < size) {
    DWORD count = 0;
    if (!ReadFile(handle, static_cast<BYTE*>(value) + offset, size - offset, &count, nullptr) || !count)
      throw std::runtime_error("Private pipe input incomplete");
    offset += count;
  }
}

Envelope input() {
  DWORD size = 0;
  read(GetStdHandle(STD_INPUT_HANDLE), &size, sizeof(size));
  if (size < 4 || size > 32768) throw std::runtime_error("Private pipe frame exceeded bound");
  Envelope result{std::vector<BYTE>(size)};
  read(GetStdHandle(STD_INPUT_HANDLE), result.data.data(), size);
  return result;
}

struct Identity {
  DWORD pid;
  uint64_t born;
  std::wstring executable;
  std::wstring digest;
};
Identity identity(Envelope& frame) {
  const auto pid = frame.integer();
  const auto born = frame.text();
  const Identity value{pid, number(born.c_str()), frame.text(), frame.text()};
  if (!value.pid || !value.born || value.digest.size() != 64 || value.digest.find_first_not_of(L"0123456789abcdef") != std::wstring::npos)
    throw std::runtime_error("Private pipe process identity invalid");
  return value;
}
HANDLE owned(const Identity& value, DWORD access = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, bool live = true) {
  Handle process(OpenProcess(access, FALSE, value.pid));
  if (!process.value || birth(process.value) != value.born || (live && WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT))
    throw std::runtime_error("Private pipe peer is not the exact live process");
  wchar_t file[4097]{};
  DWORD size = 4097;
  if (!QueryFullProcessImageNameW(process.value, 0, file, &size) || _wcsicmp(file, value.executable.c_str()))
    throw std::runtime_error("Private pipe peer executable changed");
  Handle image(CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  const auto sum = image.value == INVALID_HANDLE_VALUE ? std::string() : Source::hash(image.value);
  if (image.value == INVALID_HANDLE_VALUE || std::wstring(sum.begin(), sum.end()) != value.digest)
    throw std::runtime_error("Private pipe peer image hash changed");
  return std::exchange(process.value, nullptr);
}
DWORD parent(HANDLE process) {
  using Lookup = NTSTATUS (NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
  const auto query = reinterpret_cast<Lookup>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  PROCESS_BASIC_INFORMATION info{};
  if (!query || query(process, ProcessBasicInformation, &info, sizeof(info), nullptr) < 0)
    throw std::runtime_error("Private pipe peer parent unavailable");
  return static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(info.Reserved3));
}

void operation(HANDLE pipe, void* value, DWORD size, bool writing, ULONGLONG deadline) {
  DWORD offset = 0;
  while (offset < size) {
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.value) throw std::runtime_error("Private pipe I/O event unavailable");
    OVERLAPPED task{};
    task.hEvent = event.value;
    DWORD count = 0;
    const bool ready = writing ? !!WriteFile(pipe, static_cast<BYTE*>(value) + offset, size - offset, &count, &task) :
      !!ReadFile(pipe, static_cast<BYTE*>(value) + offset, size - offset, &count, &task);
    if (!ready) {
      if (GetLastError() != ERROR_IO_PENDING) throw std::runtime_error("Private pipe transport failed");
      const auto remaining = deadline > GetTickCount64() ? deadline - GetTickCount64() : 0;
      if (WaitForSingleObject(event.value, static_cast<DWORD>(remaining)) != WAIT_OBJECT_0) {
        CancelIoEx(pipe, &task);
        GetOverlappedResult(pipe, &task, &count, TRUE);
        throw std::runtime_error("Private pipe transport deadline exceeded");
      }
      if (!GetOverlappedResult(pipe, &task, &count, FALSE)) throw std::runtime_error("Private pipe transport completion failed");
    }
    if (!count) throw std::runtime_error("Private pipe transport closed early");
    offset += count;
  }
}

struct Security {
  HMODULE library = LoadLibraryW(L"advapi32.dll");
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  Security() {
    if (!library) throw std::runtime_error("Private pipe security unavailable");
    using Open = BOOL (WINAPI*)(HANDLE, DWORD, PHANDLE);
    using Info = BOOL (WINAPI*)(HANDLE, TOKEN_INFORMATION_CLASS, LPVOID, DWORD, PDWORD);
    using Sid = BOOL (WINAPI*)(PSID, LPWSTR*);
    using Sddl = BOOL (WINAPI*)(LPCWSTR, DWORD, PSECURITY_DESCRIPTOR*, PULONG);
    const auto open = reinterpret_cast<Open>(GetProcAddress(library, "OpenProcessToken"));
    const auto info = reinterpret_cast<Info>(GetProcAddress(library, "GetTokenInformation"));
    const auto sid = reinterpret_cast<Sid>(GetProcAddress(library, "ConvertSidToStringSidW"));
    const auto sddl = reinterpret_cast<Sddl>(GetProcAddress(library, "ConvertStringSecurityDescriptorToSecurityDescriptorW"));
    HANDLE raw = nullptr;
    if (!open || !info || !sid || !sddl || !open(GetCurrentProcess(), TOKEN_QUERY, &raw)) throw std::runtime_error("Private pipe token unavailable");
    Handle token(raw);
    DWORD size = 0;
    info(token.value, TokenUser, nullptr, 0, &size);
    if (!size || size > 65536) throw std::runtime_error("Private pipe token size invalid");
    std::vector<BYTE> bytes(size);
    if (!info(token.value, TokenUser, bytes.data(), size, &size)) throw std::runtime_error("Private pipe user unavailable");
    LPWSTR text = nullptr;
    if (!sid(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &text)) throw std::runtime_error("Private pipe SID unavailable");
    const std::wstring acl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(text) + L")";
    LocalFree(text);
    if (!sddl(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw std::runtime_error("Private pipe ACL unavailable");
    attributes.lpSecurityDescriptor = descriptor;
  }
  ~Security() { if (descriptor) LocalFree(descriptor); if (library) FreeLibrary(library); }
};

std::wstring name(Envelope& frame) {
  const auto value = frame.text();
  const std::wstring prefix = L"\\\\.\\pipe\\raya-profile-";
  if (value.size() != prefix.size() + 36 || value.substr(0, prefix.size()) != prefix || value.substr(prefix.size()).find_first_not_of(L"0123456789abcdef-") != std::wstring::npos)
    throw std::runtime_error("Private pipe name invalid");
  return value;
}

int serve() {
  auto frame = input();
  if (frame.integer() != 1) throw std::runtime_error("Private pipe version unsupported");
  const auto pipe = name(frame);
  const auto timeout = frame.integer();
  const auto count = frame.integer();
  if (timeout < 100 || timeout > 60000 || !count || count > 4096 || frame.offset + count != frame.data.size()) throw std::runtime_error("Private pipe secret bound invalid");
  Memory secret;
  secret.data.assign(frame.data.begin() + frame.offset, frame.data.end());
  SecureZeroMemory(frame.data.data(), frame.data.size());
  Security security;
  Handle handle(CreateNamedPipeW(pipe.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 8192, 8192, timeout, &security.attributes));
  if (handle.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private pipe creation refused");
  wchar_t executable[4097]{};
  if (!GetModuleFileNameW(nullptr, executable, 4097)) throw std::runtime_error("Private pipe server image unavailable");
  Handle image(CreateFileW(executable, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  if (image.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private pipe server image lock unavailable");
  const auto checksum = Source::hash(image.value);
  std::printf("{\"name\":%s,\"server\":{\"pid\":%lu,\"birth\":\"%llu\",\"executable\":%s,\"digest\":\"%s\"}}\n", Source::json(pipe).c_str(), GetCurrentProcessId(), birth(GetCurrentProcess()), Source::json(executable).c_str(), checksum.c_str());
  std::fflush(stdout);
  auto request = input();
  if (request.integer() != 1) throw std::runtime_error("Private pipe authorization version invalid");
  const auto receiver = identity(request);
  if (request.offset != request.data.size()) throw std::runtime_error("Private pipe authorization trailing fields");
  Handle owner(owned(receiver));
  const auto deadline = GetTickCount64() + timeout;
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  OVERLAPPED task{};
  task.hEvent = event.value;
  if (!ConnectNamedPipe(handle.value, &task)) {
    const auto error = GetLastError();
    if (error != ERROR_PIPE_CONNECTED) {
      if (error != ERROR_IO_PENDING || WaitForSingleObject(event.value, timeout) != WAIT_OBJECT_0) {
        CancelIoEx(handle.value, &task);
        DWORD ignored = 0;
        GetOverlappedResult(handle.value, &task, &ignored, TRUE);
        throw std::runtime_error("Private pipe connection deadline exceeded");
      }
    }
  }
  ULONG client = 0;
  if (!GetNamedPipeClientProcessId(handle.value, &client)) throw std::runtime_error("Private pipe client unavailable");
  Handle peer(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, client));
  if (!peer.value || parent(peer.value) != receiver.pid || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT)
    throw std::runtime_error("Private pipe client parent is not the authorized successor");
  const Identity expected{client, birth(peer.value), executable, std::wstring(checksum.begin(), checksum.end())};
  Handle verified(owned(expected));
  DWORD length = static_cast<DWORD>(secret.data.size());
  operation(handle.value, &length, sizeof(length), true, deadline);
  operation(handle.value, secret.data.data(), length, true, deadline);
  BYTE ack = 0;
  operation(handle.value, &ack, 1, false, deadline);
  if (ack != 1) throw std::runtime_error("Private pipe receiver did not acknowledge transport");
  std::printf("{\"received\":true,\"receiver\":%lu}\n", receiver.pid);
  return 0;
}

int receive() {
  auto frame = input();
  if (frame.integer() != 1) throw std::runtime_error("Private pipe receiver version invalid");
  const auto pipe = name(frame);
  const auto server = identity(frame);
  const auto timeout = frame.integer();
  if (frame.offset != frame.data.size() || timeout < 100 || timeout > 60000) throw std::runtime_error("Private pipe receiver bound invalid");
  Handle owner(owned(server));
  const auto deadline = GetTickCount64() + timeout;
  HANDLE raw = INVALID_HANDLE_VALUE;
  while (raw == INVALID_HANDLE_VALUE) {
    raw = CreateFileW(pipe.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (raw != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY || GetTickCount64() >= deadline || !WaitNamedPipeW(pipe.c_str(), static_cast<DWORD>(deadline - GetTickCount64()))) throw std::runtime_error("Private pipe receiver connection failed");
  }
  Handle handle(raw);
  ULONG pid = 0;
  if (!GetNamedPipeServerProcessId(handle.value, &pid) || pid != server.pid || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT)
    throw std::runtime_error("Private pipe server identity changed");
  DWORD size = 0;
  operation(handle.value, &size, sizeof(size), false, deadline);
  if (!size || size > 4096) throw std::runtime_error("Private pipe received secret bound invalid");
  Memory secret;
  secret.data.resize(size);
  operation(handle.value, secret.data.data(), size, false, deadline);
  DWORD written = 0;
  if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), secret.data.data(), size, &written, nullptr) || written != size)
    throw std::runtime_error("Private pipe private stdout delivery failed");
  BYTE ack = 1;
  operation(handle.value, &ack, 1, true, deadline);
  return 0;
}

int member(wchar_t** argv, bool outside = false) {
  const Identity source{pid(argv[2]), number(argv[3]), argv[9], argv[10]};
  const Identity helper{pid(argv[4]), number(argv[5]), argv[11], argv[12]};
  const auto job = number(argv[6]);
  const Identity caller{pid(argv[7]), number(argv[8]), argv[9], argv[10]};
  if (!job || (!outside && parent(GetCurrentProcess()) != caller.pid)) throw std::runtime_error("Native source member caller changed");
  Handle guardian(owned(helper, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE));
  Handle root(owned(source, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false));
  Handle current(owned(caller));
  HANDLE raw = nullptr;
  if (!DuplicateHandle(guardian.value, reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(job)), GetCurrentProcess(), &raw, 0, FALSE, DUPLICATE_SAME_ACCESS)) throw std::runtime_error("Native source member Job unavailable");
  Handle held(raw);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  BOOL first = FALSE, second = FALSE;
  if (!QueryInformationJobObject(held.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr) ||
    !(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) ||
    (limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) ||
    !IsProcessInJob(root.value, held.value, &first) || !first || !IsProcessInJob(current.value, held.value, &second) || (!!second == outside) ||
    (outside && parent(current.value) != helper.pid))
    throw std::runtime_error("Native source member is outside the original sealed Job");
  std::printf("{\"%s\":true,\"pid\":%lu,\"birth\":\"%llu\"}\n", outside ? "receiver" : "member", caller.pid, caller.born);
  return 0;
}
}
