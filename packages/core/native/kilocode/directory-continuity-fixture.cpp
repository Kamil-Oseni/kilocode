#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <winternl.h>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// Headless experiment only. This binary is neither a launch driver nor packaged.
// Every operation is restricted to the empty disposable directory supplied by its caller.
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE input) : value(input) {}
  ~Handle() { close(); }
  void close() {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = INVALID_HANDLE_VALUE;
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

void row(const char* name, bool success, DWORD error = 0) {
  std::printf("{\"case\":\"%s\",\"success\":%s,\"error\":%lu}\n", name, success ? "true" : "false", error);
}

void directory(const std::wstring& path) {
  if (!CreateDirectoryW(path.c_str(), nullptr)) throw std::runtime_error("Disposable directory creation failed");
}

HANDLE pin(const std::wstring& path) {
  return CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}

HANDLE attributes(const std::wstring& path) {
  return CreateFileW(path.c_str(), FILE_WRITE_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}

void file(const std::wstring& path) {
  Handle handle(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (handle.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable file creation failed");
  DWORD size = 0;
  if (!WriteFile(handle.value, "fixture", 7, &size, nullptr) || size != 7)
    throw std::runtime_error("Disposable file write failed");
}

void rename(const char* name, const std::wstring& from, const std::wstring& to) {
  const bool success = MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE;
  const DWORD error = success ? 0 : GetLastError();
  row(name, success, error);
  if (success && !MoveFileExW(to.c_str(), from.c_str(), MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Disposable rename restoration failed");
}

struct Reparse {
  DWORD tag;
  WORD length, reserved;
  WORD offset, size, display, count;
  wchar_t path[4096];
};

struct Extended {
  DWORD flags, tag;
  GUID guid;
  uint64_t reserved;
  Reparse packet;
};
static_assert(offsetof(Extended, packet) == 32);

void reparse(const char* name, HANDLE handle, const std::wstring& target, bool extended = false) {
  const auto substitute = L"\\??\\" + target;
  if (substitute.size() + target.size() + 2 > 4096) throw std::runtime_error("Disposable target exceeds bound");
  Reparse packet{};
  packet.tag = IO_REPARSE_TAG_MOUNT_POINT;
  packet.size = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  packet.display = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
  packet.count = static_cast<WORD>(target.size() * sizeof(wchar_t));
  packet.length = static_cast<WORD>(8 + (substitute.size() + target.size() + 2) * sizeof(wchar_t));
  CopyMemory(packet.path, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
  CopyMemory(packet.path + substitute.size() + 1, target.c_str(), (target.size() + 1) * sizeof(wchar_t));
  Extended wrapper{};
  wrapper.flags = 1; // REPARSE_DATA_EX_FLAG_GIVEN_TAG_OR_NONE; ExistingReparseTag is zero.
  wrapper.packet = packet;
  const auto bytes = static_cast<DWORD>(8 + packet.length);
  DWORD size = 0;
  const bool success = DeviceIoControl(handle, extended ? FSCTL_SET_REPARSE_POINT_EX : FSCTL_SET_REPARSE_POINT,
    extended ? static_cast<void*>(&wrapper) : static_cast<void*>(&packet),
    extended ? static_cast<DWORD>(offsetof(Extended, packet)) + bytes : bytes, nullptr, 0, &size, nullptr) != FALSE;
  row(name, success, success ? 0 : GetLastError());
  if (success) {
    Reparse remove{};
    remove.tag = IO_REPARSE_TAG_MOUNT_POINT;
    if (!DeviceIoControl(handle, FSCTL_DELETE_REPARSE_POINT, &remove, 8, nullptr, 0, &size, nullptr))
      throw std::runtime_error("Disposable reparse restoration failed");
  }
}

DWORD information(HANDLE handle, ULONG kind, void* packet, ULONG bytes) {
  using Set = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
  using Convert = ULONG (WINAPI*)(NTSTATUS);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  const auto set = reinterpret_cast<Set>(GetProcAddress(module, "NtSetInformationFile"));
  const auto convert = reinterpret_cast<Convert>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!set || !convert) throw std::runtime_error("Disposable POSIX API unavailable");
  IO_STATUS_BLOCK result{};
  const auto status = set(handle, &result, packet, bytes, static_cast<FILE_INFORMATION_CLASS>(kind));
  if (status == static_cast<NTSTATUS>(0x103)) throw std::runtime_error("Disposable POSIX completion is pending");
  return status < 0 ? convert(status) : 0;
}

void posix(const char* name, const std::wstring& source, const std::wstring& target = L"") {
  Handle handle(CreateFileW(source.c_str(), DELETE | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (handle.value == INVALID_HANDLE_VALUE) {
    row(name, false, GetLastError());
    return;
  }
  if (target.empty()) {
    DWORD flags = 3; // FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS.
    const auto error = information(handle.value, 64, &flags, sizeof(flags));
    row(name, !error, error);
    return;
  }
  const auto destination = L"\\??\\" + target;
  const auto bytes = offsetof(FILE_RENAME_INFO, FileName) + destination.size() * sizeof(wchar_t);
  std::vector<BYTE> buffer(bytes);
  const auto packet = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  packet->Flags = 3; // FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS.
  packet->FileNameLength = static_cast<DWORD>(destination.size() * sizeof(wchar_t));
  CopyMemory(packet->FileName, destination.data(), packet->FileNameLength);
  const auto error = information(handle.value, 65, packet, static_cast<ULONG>(bytes));
  row(name, !error, error);
}

void named(const char* name, const std::wstring& path, HANDLE expected) {
  Handle handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION before{}, after{};
  const bool same = handle.value != INVALID_HANDLE_VALUE && GetFileInformationByHandle(expected, &before) &&
    GetFileInformationByHandle(handle.value, &after) && before.dwVolumeSerialNumber == after.dwVolumeSerialNumber &&
    before.nFileIndexHigh == after.nFileIndexHigh && before.nFileIndexLow == after.nFileIndexLow;
  row(name, same);
}

void absent(const char* name, const std::wstring& path) {
  const auto flags = GetFileAttributesW(path.c_str());
  const auto error = flags == INVALID_FILE_ATTRIBUTES ? GetLastError() : 0;
  row(name, flags == INVALID_FILE_ATTRIBUTES && error == ERROR_FILE_NOT_FOUND);
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  try {
    wchar_t absolute[32768]{};
    const DWORD length = GetFullPathNameW(argv[1], 32768, absolute, nullptr);
    if (!length || length >= 32768) throw std::runtime_error("Disposable root invalid");
    const std::wstring base(absolute);
    if (base.find(L"raya-directory-experiment-") == std::wstring::npos)
      throw std::runtime_error("Disposable root name invalid");
    const DWORD flags = GetFileAttributesW(base.c_str());
    if (flags == INVALID_FILE_ATTRIBUTES || !(flags & FILE_ATTRIBUTE_DIRECTORY) || (flags & FILE_ATTRIBUTE_REPARSE_POINT))
      throw std::runtime_error("Disposable root type invalid");
    const auto ancestor = base + L"\\ancestor";
    const auto root = ancestor + L"\\root";
    const auto cwd = root + L"\\cwd";
    const auto target = base + L"\\target";
    const auto probe = base + L"\\preopened";
    for (const auto& path : {ancestor, root, cwd, target, probe}) directory(path);

    // Verify that a pre-existing DELETE grant prevents acquisition; not merely fresh opens.
    {
      Handle handle(CreateFileW(probe.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
      if (handle.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable DELETE handle unavailable");
      Handle denied(pin(probe));
      const DWORD error = denied.value == INVALID_HANDLE_VALUE ? GetLastError() : 0;
      row("preopened-delete-pin", denied.value != INVALID_HANDLE_VALUE, error);
    }

    // A metadata-only mutator already exists when the directory pins are acquired.
    Handle mutator(attributes(cwd));
    if (mutator.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable metadata handle unavailable");
    std::vector<std::unique_ptr<Handle>> pins;
    for (const auto& path : {base, ancestor, root, cwd}) {
      auto handle = std::make_unique<Handle>(pin(path));
      if (handle->value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable directory pin unavailable");
      pins.push_back(std::move(handle));
    }
    row("preopened-attributes-pin", true);
    rename("base-rename", base, base + L"-moved");
    rename("ancestor-rename", ancestor, base + L"\\ancestor-moved");
    rename("root-rename", root, ancestor + L"\\root-moved");
    rename("cwd-rename", cwd, root + L"\\cwd-moved");

    for (const auto& path : {cwd, root, base}) {
      const auto source = path + L"\\ordinary.txt";
      const auto destination = path + L"\\renamed.txt";
      file(source);
      const char* name = path == cwd ? "child-rename" : path == root ? "sibling-rename" : "ancestor-child-rename";
      rename(name, source, destination);
      const bool removed = DeleteFileW(source.c_str()) != FALSE;
      row(path == cwd ? "child-delete" : path == root ? "sibling-delete" : "ancestor-child-delete",
        removed, removed ? 0 : GetLastError());
    }
    directory(cwd + L"\\nested");
    row("nested-create", true);
    const bool removed = RemoveDirectoryW((cwd + L"\\nested").c_str()) != FALSE;
    row("nested-delete", removed, removed ? 0 : GetLastError());

    // Real supported-operation controls run with the same pinned parent as the adverse cases.
    const auto ordinary = cwd + L"\\posix-source";
    const auto replacement = cwd + L"\\posix-target";
    file(ordinary);
    file(replacement);
    Handle readable(CreateFileW(replacement.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (readable.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable POSIX readable handle unavailable");
    posix("ordinary-posix-replace", ordinary, replacement);
    absent("ordinary-posix-source-absent", ordinary);
    posix("ordinary-posix-unlink", replacement);
    absent("ordinary-posix-target-absent", replacement);
    char retained[7]{};
    DWORD count = 0;
    const bool accessible = ReadFile(readable.value, retained, 7, &count, nullptr) && count == 7 &&
      std::string(retained, 7) == "fixture";
    row("ordinary-posix-retained-stream", accessible);
    posix("cwd-posix-unlink", cwd);
    posix("cwd-posix-rename", cwd, root + L"\\cwd-posix-moved");
    named("cwd-posix-identity", cwd, pins.back()->value);

    // An empty pinned target exercises replacement independently of nonempty-directory refusal.
    Handle empty(pin(probe));
    if (empty.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable empty-directory pin unavailable");
    const auto incoming = base + L"\\incoming";
    directory(incoming);
    posix("empty-directory-posix-replace", incoming, probe);
    named("empty-directory-posix-identity", probe, empty.value);

    const auto witness = cwd + L"\\witness";
    Handle kept(CreateFileW(witness.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (kept.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable witness unavailable");
    rename("witness-rename", witness, cwd + L"\\witness-moved");
    const bool deleted = DeleteFileW(witness.c_str()) != FALSE;
    row("witness-delete", deleted, deleted ? 0 : GetLastError());
    posix("witness-posix-unlink", witness);
    posix("witness-posix-rename", witness, cwd + L"\\witness-posix-moved");
    const auto substitute = cwd + L"\\witness-substitute";
    file(substitute);
    posix("witness-posix-replace", substitute, witness);
    named("witness-posix-identity", witness, kept.value);
    if (GetFileAttributesW(substitute.c_str()) != INVALID_FILE_ATTRIBUTES && !DeleteFileW(substitute.c_str()))
      throw std::runtime_error("Disposable POSIX replacement cleanup failed");
    reparse("witness-metadata-reparse", mutator.value, target);
    reparse("witness-metadata-reparse-ex", mutator.value, target, true);
    Handle parent(attributes(root));
    if (parent.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable ancestor metadata handle unavailable");
    reparse("nonempty-ancestor-reparse", parent.value, target);
    reparse("nonempty-ancestor-reparse-ex", parent.value, target, true);
    kept.close();
    if (!DeleteFileW(witness.c_str())) throw std::runtime_error("Disposable witness cleanup failed");

    // This positive control distinguishes a true nonempty fence from access or malformed-buffer refusal.
    reparse("empty-metadata-reparse", mutator.value, target);
    reparse("empty-metadata-reparse-ex", mutator.value, target, true);
    row("experiment-finished", true);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
