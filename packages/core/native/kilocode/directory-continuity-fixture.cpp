#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
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

void reparse(const char* name, HANDLE handle, const std::wstring& target) {
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
  DWORD size = 0;
  const bool success = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &packet,
    static_cast<DWORD>(8 + packet.length), nullptr, 0, &size, nullptr) != FALSE;
  row(name, success, success ? 0 : GetLastError());
  if (success) {
    Reparse remove{};
    remove.tag = IO_REPARSE_TAG_MOUNT_POINT;
    if (!DeviceIoControl(handle, FSCTL_DELETE_REPARSE_POINT, &remove, 8, nullptr, 0, &size, nullptr))
      throw std::runtime_error("Disposable reparse restoration failed");
  }
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

    const auto witness = cwd + L"\\witness";
    Handle kept(CreateFileW(witness.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (kept.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable witness unavailable");
    rename("witness-rename", witness, cwd + L"\\witness-moved");
    const bool deleted = DeleteFileW(witness.c_str()) != FALSE;
    row("witness-delete", deleted, deleted ? 0 : GetLastError());
    reparse("witness-metadata-reparse", mutator.value, target);
    Handle parent(attributes(root));
    if (parent.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Disposable ancestor metadata handle unavailable");
    reparse("nonempty-ancestor-reparse", parent.value, target);
    kept.close();
    if (!DeleteFileW(witness.c_str())) throw std::runtime_error("Disposable witness cleanup failed");

    // This positive control distinguishes a true nonempty fence from access or malformed-buffer refusal.
    reparse("empty-metadata-reparse", mutator.value, target);
    row("experiment-finished", true);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
