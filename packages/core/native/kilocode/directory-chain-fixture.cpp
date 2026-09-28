#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <winternl.h>
#include <atomic>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

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

DWORD barrier(const std::function<DWORD()>& mutate) {
  Handle begin(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  Handle done(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!begin.value || !done.value) throw std::runtime_error("Private barrier events unavailable");
  std::atomic<DWORD> result{ERROR_IO_PENDING};
  std::jthread worker([&] {
    result.store(WaitForSingleObject(begin.value, 3000) == WAIT_OBJECT_0 ? mutate() : ERROR_TIMEOUT);
    SetEvent(done.value);
  });
  if (!SetEvent(begin.value) || WaitForSingleObject(done.value, 4000) != WAIT_OBJECT_0)
    throw std::runtime_error("Private chain mutation timed out");
  worker.join();
  return result.load();
}

struct Extended {
  DWORD flags, tag;
  GUID guid;
  uint64_t reserved;
  Reparse packet;
};
static_assert(offsetof(Extended, packet) == 32);

DWORD extended(HANDLE handle, const std::wstring& target) {
  Extended wrapper{};
  wrapper.flags = 1;
  auto& packet = wrapper.packet;
  packet.tag = IO_REPARSE_TAG_MOUNT_POINT;
  const auto substitute = L"\\??\\" + target;
  if (substitute.size() + target.size() + 2 > 4096) return ERROR_BUFFER_OVERFLOW;
  packet.size = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  packet.display = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
  packet.count = static_cast<WORD>(target.size() * sizeof(wchar_t));
  packet.length = static_cast<WORD>(8 + (substitute.size() + target.size() + 2) * sizeof(wchar_t));
  CopyMemory(packet.path, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
  CopyMemory(packet.path + substitute.size() + 1, target.c_str(), (target.size() + 1) * sizeof(wchar_t));
  DWORD bytes = 0;
  return DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT_EX, &wrapper,
    static_cast<DWORD>(offsetof(Extended, packet) + 8 + packet.length), nullptr, 0, &bytes, nullptr) ? 0 : GetLastError();
}

bool valid(HANDLE handle, const BY_HANDLE_FILE_INFORMATION& expected) {
  if (handle == INVALID_HANDLE_VALUE) return false;
  const auto observed = identity(handle);
  return same(expected, observed) && (observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
    !(observed.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

void children(const std::string& label, const std::wstring& path) {
  const auto source = path + L"\\ordinary";
  const auto target = path + L"\\renamed";
  {
    Handle file(CreateFileW(source.c_str(), GENERIC_WRITE, sharing | FILE_SHARE_DELETE, nullptr,
      CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    DWORD size = 0;
    row(label + "-child-create-write", file.value != INVALID_HANDLE_VALUE &&
      WriteFile(file.value, "fixture", 7, &size, nullptr) && size == 7);
  }
  row(label + "-child-rename", MoveFileExW(source.c_str(), target.c_str(), 0) != FALSE);
  row(label + "-child-delete", DeleteFileW(target.c_str()) != FALSE);
  const auto nested = path + L"\\nested";
  directory(nested);
  row(label + "-child-directory-delete", RemoveDirectoryW(nested.c_str()) != FALSE);
}

// Three existing edges; the anchor is already trusted. No witness is created at an ancestor.
// Modes: healthy, unacquired substitution, incomplete acquired-parent reparse, complete edge reparse, leaf race.
void chain(HANDLE anchor, const std::wstring& base, const std::wstring& outside, unsigned mode, unsigned depth) {
  const auto label = "chain-" + std::to_string(mode) + "-" + std::to_string(depth);
  const std::wstring name(label.begin(), label.end());
  const std::vector<std::wstring> names{name, L"middle", L"leaf"};
  std::vector<std::wstring> paths;
  std::vector<BY_HANDLE_FILE_INFORMATION> expected;
  auto path = base;
  for (const auto& item : names) {
    path += L"\\" + item;
    directory(path);
    paths.push_back(path);
    Handle snapshot(open(nullptr, L"\\??\\" + path, FILE_READ_ATTRIBUTES, sharing | FILE_SHARE_DELETE, 1, false));
    if (snapshot.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private chain snapshot unavailable");
    expected.push_back(identity(snapshot.value));
  }
  const unsigned affected = mode == 2 || mode == 3 ? depth : 2;
  Handle mutator(mode == 1 ? INVALID_HANDLE_VALUE : open(nullptr, L"\\??\\" + paths[affected],
    FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES, sharing | FILE_SHARE_DELETE, 1, false));
  if (mode != 1 && mutator.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private chain mutator unavailable");
  std::atomic<DWORD> mutation{ERROR_IO_PENDING};
  Restore restore(mutator.value, mutation);
  std::vector<std::unique_ptr<Handle>> pins;
  bool refused = false;
  for (unsigned edge = 0; edge < names.size(); ++edge) {
    if (mode == 1 && edge == depth) {
      const auto error = barrier([&] {
        if (!MoveFileExW(paths[edge].c_str(), (paths[edge] + L"-original").c_str(), 0)) return GetLastError();
        return CreateDirectoryW(paths[edge].c_str(), nullptr) ? 0 : GetLastError();
      });
      row(label + "-substitution", error == 0);
    }
    DWORD error = 0;
    auto pin = std::make_unique<Handle>(open(edge == 0 ? anchor : pins.back()->value, names[edge], access,
      sharing, 1, false, false, &error));
    const bool accepted = valid(pin->value, expected[edge]);
    if (!accepted) {
      row(label + "-identity-refusal", mode == 1 || mode == 2);
      if (mode == 1) {
        row(label + "-wrong-physical-id", pin->value != INVALID_HANDLE_VALUE && !same(expected[edge], identity(pin->value)));
        row(label + "-replacement-empty", empty(paths[edge]));
      }
      row(label + "-outside-before-cleanup", empty(outside));
      refused = true;
      break;
    }
    pins.push_back(std::move(pin));
    if (mode == 2 && edge == depth) {
      const auto status = barrier([&] {
        if (!MoveFileExW(paths[edge + 1].c_str(), (paths[edge] + L"-held").c_str(), 0)) return GetLastError();
        return junction(mutator.value, outside);
      });
      mutation.store(status);
      row(label + "-incomplete-parent-mutation", status == 0);
      row(label + "-reparse-observed", (identity(pins.back()->value).dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0);
    }
    if (mode == 3 && edge == depth + 1) {
      const auto first = barrier([&] { return junction(mutator.value, outside); });
      if (!first) mutation.store(0);
      row(label + "-complete-ordinary-refused", first == ERROR_DIR_NOT_EMPTY);
      if (!first) {
        row(label + "-unexpected-ordinary-outside", empty(outside));
        if (junction(mutator.value, L"", true)) throw std::runtime_error("Private unexpected ordinary junction cleanup failed");
        mutation.store(ERROR_IO_PENDING);
      }
      const auto second = barrier([&] { return extended(mutator.value, outside); });
      if (!second) mutation.store(0);
      row(label + "-complete-extended-refused", second == ERROR_DIR_NOT_EMPTY);
      row(label + "-outside-before-cleanup", empty(outside));
      if (!second) {
        if (junction(mutator.value, L"", true)) throw std::runtime_error("Private unexpected extended junction cleanup failed");
        mutation.store(ERROR_IO_PENDING);
      }
    }
  }
  if (refused) {
    restore.clear();
    row(label + "-finished", true);
    return;
  }
  row(label + "-full-identity", pins.size() == 3 && valid(pins.back()->value, expected.back()));
  const auto original = physical(pins.back()->value);
  if (mode == 4) {
    const auto error = barrier([&] { return junction(mutator.value, outside); });
    mutation.store(error);
    row(label + "-leaf-mutation", error == 0);
  }
  DWORD error = 0;
  {
    Witness witness(open(pins.back()->value, L"witness", GENERIC_READ | DELETE, sharing, 2, false, true, &error));
    const bool created = witness.value != INVALID_HANDLE_VALUE;
    row(label + "-outside-before-witness-cleanup", empty(outside));
    row(label + "-witness-local", !created || physical(witness.value) == original + L"\\witness");
    if (mode == 4) {
      row(label + "-leaf-admission-refused", !created || !valid(pins.back()->value, expected.back()));
      row(label + "-leaf-create-result", created, error);
    } else {
      row(label + "-witness-created", created);
      row(label + "-post-witness-identity", valid(pins.back()->value, expected.back()));
      const auto first = barrier([&] { return junction(mutator.value, outside); });
      if (!first) mutation.store(0);
      row(label + "-witness-ordinary-refused", first == ERROR_DIR_NOT_EMPTY);
      if (!first) {
        row(label + "-unexpected-witness-outside", empty(outside));
        if (junction(mutator.value, L"", true)) throw std::runtime_error("Private witness ordinary cleanup failed");
        mutation.store(ERROR_IO_PENDING);
      }
      const auto second = barrier([&] { return extended(mutator.value, outside); });
      if (!second) mutation.store(0);
      row(label + "-witness-extended-refused", second == ERROR_DIR_NOT_EMPTY);
      if (!second) {
        row(label + "-unexpected-witness-extended-outside", empty(outside));
        if (junction(mutator.value, L"", true)) throw std::runtime_error("Private witness extended cleanup failed");
        mutation.store(ERROR_IO_PENDING);
      }
      for (unsigned index = 0; index < paths.size(); ++index) children(label + "-" + std::to_string(index), paths[index]);
      for (unsigned index = 0; index < pins.size(); ++index)
        row(label + "-retained-" + std::to_string(index), valid(pins[index]->value, expected[index]));
      for (unsigned index = 0; index < paths.size(); ++index) {
        const bool moved = MoveFileExW(paths[index].c_str(), (paths[index] + L"-moved").c_str(), 0) != FALSE;
        const DWORD status = moved ? 0 : GetLastError();
        row(label + "-pinned-rename-refused-" + std::to_string(index), !moved && status == ERROR_SHARING_VIOLATION);
        if (moved && !MoveFileExW((paths[index] + L"-moved").c_str(), paths[index].c_str(), 0))
          throw std::runtime_error("Private unexpected rename restoration failed");
      }
    }
    if (created) witness.erase();
  }
  restore.clear();
  if (mode == 0) {
    // EX must actually succeed on this same metadata handle once the leaf witness is gone.
    const auto status = extended(mutator.value, outside);
    mutation.store(status);
    row(label + "-extended-positive", status == 0);
    Restore control(mutator.value, mutation);
    row(label + "-extended-observed", (identity(pins.back()->value).dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0);
    row(label + "-extended-outside-before-cleanup", empty(outside));
    control.clear();
    const auto branch = paths[0] + L"\\branch";
    directory(branch);
    Handle snapshot(open(pins[0]->value, L"branch", FILE_READ_ATTRIBUTES, sharing | FILE_SHARE_DELETE, 1, false));
    if (snapshot.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private branch snapshot unavailable");
    const auto trusted = identity(snapshot.value);
    Handle pin(open(pins[0]->value, L"branch", access, sharing, 1, false));
    row(label + "-branch-identity", valid(pin.value, trusted));
    if (pin.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private branch acquisition unavailable");
    Witness witness(open(pin.value, L"witness", GENERIC_READ | DELETE, sharing, 2, false, true));
    row(label + "-branch-witness", witness.value != INVALID_HANDLE_VALUE &&
      physical(witness.value) == physical(pin.value) + L"\\witness");
    children(label + "-branch", branch);
    if (witness.value != INVALID_HANDLE_VALUE) witness.erase();
  }
  row(label + "-outside-final", empty(outside));
  row(label + "-finished", true);
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 4) return 2;
  try {
    wchar_t buffer[32768]{};
    const DWORD size = GetFullPathNameW(argv[1], 32768, buffer, nullptr);
    if (!size || size >= 32768) throw std::runtime_error("Private disposable root invalid");
    const std::wstring base(buffer);
    const auto split = base.find_last_of(L'\\');
    if (split == std::wstring::npos || base.substr(split + 1).find(L"raya-chain-experiment-") != 0)
      throw std::runtime_error("Private disposable root name invalid");
    Handle anchor(open(nullptr, L"\\??\\" + base, access, sharing, 1, false));
    if (anchor.value == INVALID_HANDLE_VALUE || !empty(base)) throw std::runtime_error("Private empty anchor unavailable");
    const auto trusted = identity(anchor.value);
    if (!(trusted.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (trusted.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
      throw std::runtime_error("Private anchor type invalid");
    size_t parsed = 0;
    const std::wstring device(argv[2]), inode(argv[3]);
    const auto dev = std::stoull(device, &parsed);
    if (parsed != device.size()) throw std::runtime_error("Private device identity invalid");
    const auto ino = std::stoull(inode, &parsed);
    if (parsed != inode.size()) throw std::runtime_error("Private inode identity invalid");
    const auto index = (static_cast<uint64_t>(trusted.nFileIndexHigh) << 32) | trusted.nFileIndexLow;
    row("bun-native-device-equal", dev == trusted.dwVolumeSerialNumber);
    row("bun-native-inode-equal", ino == index);
    const auto outside = base + L"\\outside";
    directory(outside);
    Handle target(open(anchor.value, L"outside", access, sharing, 1, false));
    if (target.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Private independent target unavailable");
    const auto expected = identity(target.value);
    chain(anchor.value, base, outside, 0, 0);
    for (unsigned depth = 0; depth < 3; ++depth) chain(anchor.value, base, outside, 1, depth);
    for (unsigned depth = 0; depth < 2; ++depth) chain(anchor.value, base, outside, 2, depth);
    for (unsigned depth = 0; depth < 2; ++depth) chain(anchor.value, base, outside, 3, depth);
    chain(anchor.value, base, outside, 4, 0);
    row("outside-final-identity", valid(target.value, expected));
    row("outside-final-empty", empty(outside));
    row("experiment-finished", true);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
