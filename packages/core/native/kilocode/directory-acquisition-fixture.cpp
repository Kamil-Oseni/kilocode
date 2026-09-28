#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <winternl.h>
#include <atomic>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>

// Private headless acquisition experiment. No process launch, desktop APIs, or production integration.
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

void row(const std::string& name, bool success, DWORD error = 0) {
  std::printf("{\"case\":\"%s\",\"success\":%s,\"error\":%lu}\n", name.c_str(), success ? "true" : "false", error);
}

DWORD convert(NTSTATUS status) {
  using Convert = ULONG (WINAPI*)(NTSTATUS);
  const auto function = reinterpret_cast<Convert>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
  if (!function) throw std::runtime_error("Private status conversion unavailable");
  return function(status);
}

HANDLE open(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG share, ULONG disposition,
    bool guarded, bool witness = false, DWORD* error = nullptr) {
  using Create = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  const auto function = reinterpret_cast<Create>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (!function || name.empty() || name.size() > 4096) throw std::runtime_error("Private acquisition request invalid");
  UNICODE_STRING text{};
  text.Buffer = const_cast<wchar_t*>(name.data());
  text.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &text;
  attributes.Attributes = 0x40 | (guarded ? 0x1000 : 0); // OBJ_CASE_INSENSITIVE | optional OBJ_DONT_REPARSE.
  IO_STATUS_BLOCK result{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  // Type-neutral directory opens avoid relying on undocumented DIRECTORY_FILE option combinations.
  const ULONG options = 0x20 | 0x200000 | (witness ? 0x40 : 0); // synchronous, final-component no-follow, optional non-directory.
  const auto status = function(&handle, access | SYNCHRONIZE, &attributes, &result, nullptr,
    FILE_ATTRIBUTE_NORMAL, share, disposition, options, nullptr, 0);
  if (status == static_cast<NTSTATUS>(0x103)) throw std::runtime_error("Private acquisition completion pending");
  if (status < 0) {
    if (error) *error = convert(status);
    return INVALID_HANDLE_VALUE;
  }
  if (error) *error = 0;
  return handle;
}

BY_HANDLE_FILE_INFORMATION identity(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION result{};
  if (!GetFileInformationByHandle(handle, &result)) throw std::runtime_error("Private physical identity unavailable");
  return result;
}

bool same(const BY_HANDLE_FILE_INFORMATION& before, const BY_HANDLE_FILE_INFORMATION& after) {
  return before.dwVolumeSerialNumber == after.dwVolumeSerialNumber && before.nFileIndexHigh == after.nFileIndexHigh &&
    before.nFileIndexLow == after.nFileIndexLow;
}

std::wstring physical(HANDLE handle) {
  wchar_t buffer[4101]{};
  const DWORD count = GetFinalPathNameByHandleW(handle, buffer, 4101, FILE_NAME_OPENED | VOLUME_NAME_NT);
  if (!count || count >= 4101) throw std::runtime_error("Private physical path unavailable");
  return buffer;
}

void directory(const std::wstring& path) {
  if (!CreateDirectoryW(path.c_str(), nullptr)) throw std::runtime_error("Private disposable directory creation failed");
}

bool empty(const std::wstring& path) {
  WIN32_FIND_DATAW entry{};
  const HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
  if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool result = true;
  unsigned count = 0;
  do {
    if (++count > 32 || (std::wstring(entry.cFileName) != L"." && std::wstring(entry.cFileName) != L"..")) result = false;
  } while (count <= 32 && FindNextFileW(search, &entry));
  const DWORD error = GetLastError();
  FindClose(search);
  return result && error == ERROR_NO_MORE_FILES;
}

struct Reparse {
  DWORD tag;
  WORD length, reserved, offset, size, display, count;
  wchar_t path[4096];
};

DWORD junction(HANDLE handle, const std::wstring& target, bool remove = false) {
  Reparse packet{};
  packet.tag = IO_REPARSE_TAG_MOUNT_POINT;
  if (!remove) {
    const auto substitute = L"\\??\\" + target;
    if (substitute.size() + target.size() + 2 > 4096) return ERROR_BUFFER_OVERFLOW;
    packet.size = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
    packet.display = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
    packet.count = static_cast<WORD>(target.size() * sizeof(wchar_t));
    packet.length = static_cast<WORD>(8 + (substitute.size() + target.size() + 2) * sizeof(wchar_t));
    CopyMemory(packet.path, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
    CopyMemory(packet.path + substitute.size() + 1, target.c_str(), (target.size() + 1) * sizeof(wchar_t));
  }
  DWORD bytes = 0;
  return DeviceIoControl(handle, remove ? FSCTL_DELETE_REPARSE_POINT : FSCTL_SET_REPARSE_POINT,
    &packet, static_cast<DWORD>(8 + packet.length), nullptr, 0, &bytes, nullptr) ? 0 : GetLastError();
}

void discard(HANDLE handle) {
  FILE_DISPOSITION_INFO packet{TRUE};
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &packet, sizeof(packet)))
    throw std::runtime_error("Private exact witness cleanup failed");
}

struct Witness {
  HANDLE value;
  bool erased = false;
  explicit Witness(HANDLE handle) : value(handle) {}
  ~Witness() {
    if (value == INVALID_HANDLE_VALUE) return;
    FILE_DISPOSITION_INFO packet{TRUE};
    if (!erased && !SetFileInformationByHandle(value, FileDispositionInfo, &packet, sizeof(packet)))
      std::fprintf(stderr, "Private exact witness finalizer failed\n");
    CloseHandle(value);
  }
  void erase() { discard(value); erased = true; }
  Witness(const Witness&) = delete;
  Witness& operator=(const Witness&) = delete;
};

struct Restore {
  HANDLE handle;
  const std::atomic<DWORD>& result;
  bool active = true;
  Restore(HANDLE input, const std::atomic<DWORD>& status) : handle(input), result(status) {}
  ~Restore() {
    if (active && result.load() == 0 && junction(handle, L"", true))
      std::fprintf(stderr, "Private reparse finalizer failed\n");
  }
  void clear() {
    if (result.load() == 0 && junction(handle, L"", true))
      throw std::runtime_error("Private junction restoration failed");
    active = false;
  }
};

constexpr ACCESS_MASK access = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES;
constexpr ULONG sharing = FILE_SHARE_READ | FILE_SHARE_WRITE;

void plain(HANDLE parent, const std::wstring& base, const std::wstring& target, bool guarded, bool wrong) {
  const std::string label = wrong ? "wrong" : guarded ? "guarded-plain" : "plain";
  const std::wstring name(label.begin(), label.end());
  const auto path = base + L"\\" + name;
  directory(path);
  BY_HANDLE_FILE_INFORMATION expected{};
  {
    Handle authorized(open(parent, name, FILE_READ_ATTRIBUTES, sharing | FILE_SHARE_DELETE, 1, false));
    if (authorized.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private authorization snapshot unavailable");
    expected = identity(authorized.value);
  }
  if (wrong) {
    if (!MoveFileExW(path.c_str(), (path + L"-original").c_str(), 0))
      throw std::runtime_error("Private wrong-target substitution failed");
    directory(path);
  }
  Handle leaf(open(parent, name, access, sharing, 1, guarded));
  if (leaf.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private relative leaf acquisition unavailable");
  const auto observed = identity(leaf.value);
  const bool admitted = same(expected, observed) && (observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
    !(observed.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
  row(label + "-identity", wrong ? !admitted : admitted);
  if (admitted) {
    Witness witness(open(leaf.value, L"witness", GENERIC_READ | DELETE, sharing, 2, guarded, true));
    if (witness.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private positive witness creation unavailable");
    row(label + "-physical", physical(witness.value) == physical(leaf.value) + L"\\witness");
    witness.erase();
  }
  row(label + "-outside-empty", empty(target));
  if (wrong) row("wrong-no-witness", empty(path));
}

void race(HANDLE parent, const std::wstring& base, const std::wstring& target, bool guarded) {
  const std::string label = guarded ? "guarded-race" : "race";
  const std::wstring name(label.begin(), label.end());
  const auto path = base + L"\\" + name;
  directory(path);
  Handle mutator(open(parent, name, FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES, sharing | FILE_SHARE_DELETE, 1, false));
  if (mutator.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private metadata mutator unavailable");
  const auto expected = identity(mutator.value);
  Handle leaf(open(parent, name, access, sharing, 1, guarded));
  if (leaf.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private race leaf unavailable");
  row(label + "-initial-identity", same(expected, identity(leaf.value)));
  const auto original = physical(leaf.value);
  Handle begin(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  Handle done(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!begin.value || !done.value) throw std::runtime_error("Private race events unavailable");
  std::atomic<DWORD> result{ERROR_IO_PENDING};
  Restore restore(mutator.value, result);
  std::jthread worker([&] {
    const DWORD state = WaitForSingleObject(begin.value, 3000);
    result.store(state == WAIT_OBJECT_0 ? junction(mutator.value, target) : ERROR_TIMEOUT);
    SetEvent(done.value);
  });
  if (!SetEvent(begin.value) || WaitForSingleObject(done.value, 4000) != WAIT_OBJECT_0)
    throw std::runtime_error("Private metadata mutation barrier timed out");
  worker.join();
  row(label + "-mutation", result.load() == 0, result.load());
  const auto mutated = identity(leaf.value);
  row(label + "-reparse-observed", (mutated.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0);
  DWORD error = 0;
  bool created = false;
  bool local = false;
  {
    Witness witness(open(leaf.value, L"witness", GENERIC_READ | DELETE, sharing, 2, guarded, true, &error));
    created = witness.value != INVALID_HANDLE_VALUE;
    local = !created || physical(witness.value) == original + L"\\witness";
    // The independent outside target is checked before removing any witness, so cleanup cannot hide an escape.
    row(label + "-outside-empty", empty(target));
    row(label + "-safe-witness", local);
    row(label + "-admission-refused", !created ||
      (identity(leaf.value).dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0);
    row(label + "-creation", created, error);
    if (created) witness.erase();
  }
  restore.clear();
  row(label + "-cleanup", empty(path) && empty(target));
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  try {
    wchar_t buffer[32768]{};
    const DWORD size = GetFullPathNameW(argv[1], 32768, buffer, nullptr);
    if (!size || size >= 32768) throw std::runtime_error("Private disposable root invalid");
    const std::wstring base(buffer);
    const auto split = base.find_last_of(L'\\');
    if (split == std::wstring::npos || base.substr(split + 1).find(L"raya-acquisition-experiment-") != 0)
      throw std::runtime_error("Private disposable root name invalid");
    Handle parent(open(nullptr, L"\\??\\" + base, access, sharing, 1, false));
    if (parent.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private parent acquisition unavailable");
    const auto root = identity(parent.value);
    if (!(root.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (root.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || !empty(base))
      throw std::runtime_error("Private disposable root is not an empty non-reparse directory");
    const auto target = base + L"\\outside";
    directory(target);
    Handle outside(open(parent.value, L"outside", access, sharing, 1, false));
    if (outside.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private outside target unavailable");
    const auto expected = identity(outside.value);
    plain(parent.value, base, target, false, false);
    plain(parent.value, base, target, true, false);
    plain(parent.value, base, target, false, true);
    race(parent.value, base, target, false);
    race(parent.value, base, target, true);
    Handle observed(open(parent.value, L"outside", access, sharing, 1, false));
    row("outside-final-identity", observed.value != INVALID_HANDLE_VALUE && same(expected, identity(observed.value)));
    row("outside-final-empty", empty(target));
    row("experiment-finished", true);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
