#include <aclapi.h>
#include <sddl.h>
#include <filesystem>
#include <set>

// Ordinary data writers are fenced; permission-changing
// principals are detected/refused, not treated as a hostile security boundary.
namespace Offline {
namespace fs = std::filesystem;
// Only I/O receives an extended-length DOS path. Protocols, policies and file-ID
// journals keep the original normalized logical path.
std::wstring native(const std::wstring& file) {
  if (file.size() < 3 || file.size() > 4096 || file[1] != L':' || file[2] != L'\\')
    throw std::runtime_error("Offline native path invalid");
  wchar_t full[4101]{};
  const DWORD length = GetFullPathNameW(file.c_str(), 4101, full, nullptr);
  if (!length || length >= 4101 || _wcsicmp(full, file.c_str()))
    throw std::runtime_error("Offline native path invalid");
  return L"\\\\?\\" + file;
}
std::wstring canonical(const std::wstring& file) {
  Handle handle(CreateFileW(native(file).c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  wchar_t physical[4101]{};
  const DWORD count = handle.value == INVALID_HANDLE_VALUE ? 0 :
    GetFinalPathNameByHandleW(handle.value, physical, 4101, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!count || count >= 4101 || std::wstring(physical).substr(0, 4) != L"\\\\?\\")
    throw std::runtime_error("Offline canonical path unavailable");
  return std::wstring(physical + 4);
}
bool exists(const std::wstring& file) {
  if (GetFileAttributesW(native(file).c_str()) != INVALID_FILE_ATTRIBUTES) return true;
  const auto code = GetLastError();
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return false;
  throw std::runtime_error("Offline native path unavailable");
}
HANDLE immutable(const std::wstring& file) {
  const HANDLE handle = CreateFileW(native(file).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle != INVALID_HANDLE_VALUE) return handle;
  const DWORD code = GetLastError();
  if (code == ERROR_SHARING_VIOLATION) throw std::runtime_error("Offline immutable stage sharing refused");
  if (code == ERROR_ACCESS_DENIED) throw std::runtime_error("Offline immutable stage access refused");
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) throw std::runtime_error("Offline immutable stage missing refused");
  if (code == ERROR_TOO_MANY_OPEN_FILES || code == ERROR_NOT_ENOUGH_MEMORY || code == ERROR_OUTOFMEMORY || code == ERROR_NO_SYSTEM_RESOURCES)
    throw std::runtime_error("Offline immutable stage resources refused");
  throw std::runtime_error("Offline immutable stage handle refused");
}
struct Node {
  std::wstring path;
  Handle handle;
  Handle backup;
  BY_HANDLE_FILE_INFORMATION info{};
  std::wstring original;
  std::wstring expected;
  bool directory = false;
  bool changed = false;
  explicit Node(const std::wstring& file) : path(file),
      handle(CreateFileW(native(file).c_str(), GENERIC_READ | READ_CONTROL | WRITE_DAC,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)), backup(nullptr) {
    if (handle.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Offline exclusive source handle refused");
    if (!GetFileInformationByHandle(handle.value, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
      throw std::runtime_error("Offline source reparse/identity refused");
    directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (!directory && info.nNumberOfLinks != 1) throw std::runtime_error("Offline source hardlink refused");
    if (_wcsicmp(canonical(file).c_str(), file.c_str())) throw std::runtime_error("Offline canonical source changed");
    if (!DuplicateHandle(GetCurrentProcess(), handle.value, GetCurrentProcess(), &backup.value, 0, FALSE, DUPLICATE_SAME_ACCESS))
      throw std::runtime_error("Offline backup restoration handle refused");
    original = security();
  }
  std::wstring security() const {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const auto code = GetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor);
    if (code != ERROR_SUCCESS) throw std::runtime_error("Offline security descriptor unavailable");
    LPWSTR text = nullptr;
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, nullptr)) {
      LocalFree(descriptor); throw std::runtime_error("Offline security descriptor serialization failed");
    }
    std::wstring result(text); LocalFree(text); LocalFree(descriptor); return result;
  }
  void set(const std::wstring& text) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
      throw std::runtime_error("Offline original security descriptor invalid");
    PACL acl = nullptr; BOOL present = FALSE, defaulted = FALSE;
    SECURITY_DESCRIPTOR_CONTROL flags{}; DWORD revision = 0;
    if (!GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) || !present ||
        !GetSecurityDescriptorControl(descriptor, &flags, &revision)) {
      LocalFree(descriptor); throw std::runtime_error("Offline original DACL invalid");
    }
    const auto code = SetSecurityInfo(handle.value, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | ((flags & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION),
      nullptr, nullptr, acl, nullptr);
    LocalFree(descriptor);
    if (code != ERROR_SUCCESS) throw std::runtime_error("Offline handle DACL update refused");
  }
  void fence() {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(original.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
      throw std::runtime_error("Offline source DACL decode failed");
    PACL previous = nullptr; BOOL present = FALSE, defaulted = FALSE;
    if (!GetSecurityDescriptorDacl(descriptor, &present, &previous, &defaulted) || !present || !previous) {
      LocalFree(descriptor); throw std::runtime_error("Offline source DACL absent");
    }
    const DWORD size = previous->AclSize + sizeof(ACCESS_DENIED_ACE) + SECURITY_MAX_SID_SIZE;
    std::vector<BYTE> bytes(size); auto acl = reinterpret_cast<PACL>(bytes.data());
    BYTE sid[SECURITY_MAX_SID_SIZE]{}; DWORD sidSize = sizeof(sid);
    if (!CreateWellKnownSid(WinWorldSid, nullptr, sid, &sidSize) || !InitializeAcl(acl, size, ACL_REVISION_DS) ||
        !AddAccessDeniedAceEx(acl, ACL_REVISION_DS, 0, FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
          FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD | DELETE, sid)) {
      LocalFree(descriptor); throw std::runtime_error("Offline data denial construction failed");
    }
    for (DWORD index = 0; index < previous->AceCount; ++index) {
      LPVOID ace = nullptr;
      if (!GetAce(previous, index, &ace) || !AddAce(acl, ACL_REVISION_DS, MAXDWORD, ace, static_cast<PACE_HEADER>(ace)->AceSize)) {
        LocalFree(descriptor); throw std::runtime_error("Offline original ACE preservation failed");
      }
    }
    changed = true; // Journal already durable; any uncertain update requires restoration.
    const auto code = SetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, acl, nullptr);
    LocalFree(descriptor);
    if (code != ERROR_SUCCESS) throw std::runtime_error("Offline namespace data denial refused");
    expected = security();
  }
  void check() const {
    BY_HANDLE_FILE_INFORMATION actual{};
    if (!GetFileInformationByHandle(handle.value, &actual) || actual.dwVolumeSerialNumber != info.dwVolumeSerialNumber ||
        actual.nFileIndexHigh != info.nFileIndexHigh || actual.nFileIndexLow != info.nFileIndexLow ||
        (!directory && (actual.nNumberOfLinks != 1 || actual.nFileSizeHigh != info.nFileSizeHigh ||
          actual.nFileSizeLow != info.nFileSizeLow || CompareFileTime(&actual.ftLastWriteTime, &info.ftLastWriteTime))) || _wcsicmp(canonical(path).c_str(), path.c_str()) ||
        (!expected.empty() && security() != expected))
      throw std::runtime_error("Offline source identity/security changed while held");
  }
  void restore() {
    if (changed) {set(original); changed = false;}
    if (security() != original) throw std::runtime_error("Offline exact DACL restoration differs");
  }
};

void integer(std::vector<BYTE>& bytes, DWORD value) {
  const auto pointer = reinterpret_cast<const BYTE*>(&value); bytes.insert(bytes.end(), pointer, pointer + sizeof(value));
}
void text(std::vector<BYTE>& bytes, const std::wstring& value) {
  if (value.size() > 32768) throw std::runtime_error("Offline journal field exceeded bound");
  integer(bytes, static_cast<DWORD>(value.size()));
  const auto pointer = reinterpret_cast<const BYTE*>(value.data()); bytes.insert(bytes.end(), pointer, pointer + value.size() * sizeof(wchar_t));
}
std::vector<BYTE> protect(const std::vector<BYTE>& bytes, bool recover) {
  DATA_BLOB input{static_cast<DWORD>(bytes.size()), const_cast<BYTE*>(bytes.data())}, output{};
  const BOOL accepted = recover ? CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output) :
    CryptProtectData(&input, L"Raya offline original DACL journal", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
  if (!accepted) throw std::runtime_error("Offline authenticated journal refused");
  std::vector<BYTE> result(output.pbData, output.pbData + output.cbData); LocalFree(output.pbData); return result;
}
void durable(const std::wstring& file, const std::vector<BYTE>& bytes, Handle& pin) {
  const auto temp = file + L".pending";
  Handle output(CreateFileW(native(temp).c_str(), GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, CREATE_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr));
  if (output.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Offline journal output refused");
  DWORD count = 0;
  if (bytes.size() > 32 * 1024 * 1024 || !WriteFile(output.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) ||
      count != bytes.size() || !FlushFileBuffers(output.value)) throw std::runtime_error("Offline journal persistence failed");
  const auto target = native(file);
  // FileRenameInfoEx flags: replace existing + POSIX open-handle replacement, with no read-only bypass.
  const DWORD flags = 3;
  std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO) + target.size() * sizeof(wchar_t));
  auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  std::memcpy(storage.data(), &flags, sizeof(flags));
  rename->RootDirectory = nullptr;
  rename->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
  std::memcpy(rename->FileName, target.data(), rename->FileNameLength);
  if (!SetFileInformationByHandle(output.value, static_cast<FILE_INFO_BY_HANDLE_CLASS>(22), rename, static_cast<DWORD>(storage.size())))
    throw std::runtime_error("Offline journal atomic publication refused");
  // The named journal stays pinned even when the post-rename durability flush refuses.
  if (pin.value) CloseHandle(pin.value);
  pin.value = std::exchange(output.value, nullptr);
  if (!FlushFileBuffers(pin.value)) throw std::runtime_error("Offline journal persistence failed");
}
struct State {
  mutable Handle publication{nullptr};
  DWORD version = 1;
  std::wstring control;
  std::wstring generation;
  std::vector<std::unique_ptr<Node>> nodes;
  std::map<std::wstring, Node*> known;
  std::map<std::wstring, std::unique_ptr<Handle>> ancestors;
  struct Pin { std::wstring path; BY_HANDLE_FILE_INFORMATION info; };
  std::map<std::wstring, Pin> pins;
  DWORD maximum = 16384;
  uint64_t limit = 1024ull * 1024ull * 1024ull;
  uint64_t bytes = 0;
  void parents(const std::wstring& selected, const std::wstring& boundary = L"") {
    for (auto current = fs::path(selected).parent_path(); !current.empty(); current = current.parent_path()) {
      const auto file = current.wstring(); const auto key = Source::lower(file);
      const bool strict = !boundary.empty() && Source::inside(boundary, file);
      if (!ancestors.count(key) || (strict && !pins.count(key))) {
        if (ancestors.size() >= maximum) throw std::runtime_error("Offline ancestor count exceeded bound");
        auto handle = std::make_unique<Handle>(CreateFileW(native(file).c_str(), strict ? GENERIC_READ : FILE_READ_ATTRIBUTES,
          // Generic read without delete sharing pins directory renames. Write sharing permits our own journal replacement below control.
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
          FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        BY_HANDLE_FILE_INFORMATION info{};
        if (handle->value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle->value, &info) ||
            !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
          throw std::runtime_error("Offline ancestor rename/reparse admission refused");
        if (strict) {
          const auto previous = ancestors.find(key);
          BY_HANDLE_FILE_INFORMATION before{};
          if (previous != ancestors.end() && (!GetFileInformationByHandle(previous->second->value, &before) ||
              before.dwVolumeSerialNumber != info.dwVolumeSerialNumber || before.nFileIndexHigh != info.nFileIndexHigh || before.nFileIndexLow != info.nFileIndexLow))
            throw std::runtime_error("Offline control branch changed before pinning");
          pins.emplace(key, Pin{file, info});
        }
        ancestors.insert_or_assign(key, std::move(handle));
      }
      if (current.parent_path() == current) break;
    }
  }
  void check() const {
    for (const auto& node : nodes) node->check();
    for (const auto& item : pins) {
      BY_HANDLE_FILE_INFORMATION info{};
      const auto& pin = item.second;
      if (!GetFileInformationByHandle(ancestors.at(item.first)->value, &info) ||
          info.dwVolumeSerialNumber != pin.info.dwVolumeSerialNumber || info.nFileIndexHigh != pin.info.nFileIndexHigh || info.nFileIndexLow != pin.info.nFileIndexLow ||
          _wcsicmp(canonical(pin.path).c_str(), pin.path.c_str())) throw std::runtime_error("Offline control branch changed while held");
    }
  }
  void journal(bool restored = false) const {
    std::vector<BYTE> value; integer(value, 1); integer(value, restored ? 1u : 0u); text(value, generation);
    integer(value, GetCurrentProcessId()); text(value, std::to_wstring(birth(GetCurrentProcess())));
    integer(value, static_cast<DWORD>(nodes.size()));
    for (const auto& node : nodes) {
      text(value, node->path); integer(value, node->directory ? 1u : 0u);
      integer(value, node->info.dwVolumeSerialNumber); integer(value, node->info.nFileIndexHigh); integer(value, node->info.nFileIndexLow);
      text(value, node->original);
      if (value.size() > 16 * 1024 * 1024) throw std::runtime_error("Offline journal metadata exceeded bound");
    }
    durable(control + L"\\journal.bin", protect(value, false), publication);
  }
  Node& admit(const std::wstring& file) {
    const auto key = Source::lower(file); const auto found = known.find(key); if (found != known.end()) return *found->second;
    if (nodes.size() >= maximum) throw std::runtime_error("Offline tree count exceeded bound");
    auto node = std::make_unique<Node>(file); auto pointer = node.get();
    nodes.push_back(std::move(node)); known.emplace(key, pointer);
    journal(); pointer->fence(); return *pointer;
  }
  void restore() {
    std::vector<std::string> failures;
    for (auto& node : nodes) {
      try {node->restore();} catch (const std::exception& error) {
        failures.push_back(error.what());
        CloseHandle(node->handle.value); node->handle.value = std::exchange(node->backup.value, nullptr);
        try {node->restore();} catch (const std::exception& nested) {failures.push_back(nested.what());}
      }
    }
    // A failure remains refusal even if the backup restores exact ACLs.
    for (const auto& node : nodes) if (node->security() != node->original)
      throw std::runtime_error("Offline rollback remains uncertain; journal retained");
    journal(true);
    if (!failures.empty()) throw std::runtime_error("Offline rollback encountered a retained failure");
  }
  std::vector<std::string> records;
  std::vector<std::string> folders;
  std::vector<std::unique_ptr<Handle>> images;
  std::set<std::wstring> directories;
  std::set<std::wstring> files;
  void directory(const std::wstring& target) {
    fs::create_directories(native(target));
    const auto image = control + L"\\image";
    for (auto current = fs::path(target); Source::inside(image, current.wstring()); current = current.parent_path()) {
      directories.insert(current.wstring());
      if (current.wstring() == image) break;
    }
  }
  void seal() {
    // Raw bytes and raw namespaces are immutable until rollback; writable
    // SQLite recovery belongs in control/working, never in control/image.
    for (const auto& path : directories) admit(path);
    if (version >= 4) for (const auto& path : files) admit(path);
    for (const auto& path : directories) for (const auto& item : fs::directory_iterator(native(path))) {
      const auto target = path + L"\\" + item.path().filename().wstring(); const DWORD attrs = GetFileAttributesW(native(target).c_str());
      if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) ||
          ((attrs & FILE_ATTRIBUTE_DIRECTORY) ? !directories.count(target) : !files.count(target)))
        throw std::runtime_error("Offline raw image contains an unrecorded object");
    }
  }
  void stage(const std::wstring& origin, const std::wstring& target, DWORD depth = 0) {
    if (depth > 64) throw std::runtime_error("Offline directory depth exceeded bound");
    auto& node = admit(origin); node.check();
    if (node.directory) {
      directory(target);
      std::vector<std::wstring> names;
      for (const auto& item : fs::directory_iterator(native(origin))) {
        if (names.size() >= maximum) throw std::runtime_error("Offline directory inventory exceeded bound");
        names.push_back(item.path().filename().wstring());
      }
      std::sort(names.begin(), names.end());
      std::string children;
      for (const auto& name : names) {
        const auto file = origin + L"\\" + name;
        auto& child = admit(file); child.check();
        if (!children.empty()) children += ",";
        children += "{\"name\":" + Source::json(name) + ",\"directory\":" + (child.directory ? "true" : "false") +
          ",\"volume\":" + std::to_string(child.info.dwVolumeSerialNumber) + ",\"index\":\"" +
          std::to_string((static_cast<uint64_t>(child.info.nFileIndexHigh) << 32) | child.info.nFileIndexLow) + "\"}";
        stage(file, target + L"\\" + name, depth + 1);
      }
      if (folders.size() >= maximum) throw std::runtime_error("Offline directory inventory exceeded bound");
      folders.push_back("{\"original\":" + Source::json(origin) + ",\"staged\":" + Source::json(target) +
        ",\"volume\":" + std::to_string(node.info.dwVolumeSerialNumber) + ",\"index\":\"" +
        std::to_string((static_cast<uint64_t>(node.info.nFileIndexHigh) << 32) | node.info.nFileIndexLow) + "\",\"children\":[" + children + "]}");
      node.check(); return;
    }
    const uint64_t size = (static_cast<uint64_t>(node.info.nFileSizeHigh) << 32) | node.info.nFileSizeLow;
    if (size > limit - bytes) throw std::runtime_error("Offline stage byte limit exceeded");
    bytes += size; directory(fs::path(target).parent_path().wstring());
    Handle output(CreateFileW(native(target).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr));
    if (output.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Offline private stage output refused");
    LARGE_INTEGER start{};
    if (!SetFilePointerEx(node.handle.value, start, nullptr, FILE_BEGIN)) throw std::runtime_error("Offline source seek failed");
    std::vector<BYTE> buffer(65536); uint64_t copied = 0;
    while (true) {
      DWORD count = 0, written = 0;
      if (!ReadFile(node.handle.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr)) throw std::runtime_error("Offline pinned source read failed");
      if (!count) break;
      if (!WriteFile(output.value, buffer.data(), count, &written, nullptr) || written != count) throw std::runtime_error("Offline stage write failed");
      copied += count;
    }
    if (copied != size || !FlushFileBuffers(output.value) || !SetFilePointerEx(node.handle.value, start, nullptr, FILE_BEGIN))
      throw std::runtime_error("Offline stage size/flush differs");
    if (version >= 4) {
      if (!SetFileTime(output.value, nullptr, nullptr, &node.info.ftLastWriteTime))
        throw std::runtime_error("Offline stage timestamp publication refused");
      BY_HANDLE_FILE_INFORMATION actual{};
      if (!GetFileInformationByHandle(output.value, &actual) ||
          CompareFileTime(&actual.ftLastWriteTime, &node.info.ftLastWriteTime))
        throw std::runtime_error("Offline stage timestamp differs");
    }
    if (!CloseHandle(output.value)) throw std::runtime_error("Offline stage writer close refused");
    output.value = nullptr;
    Handle image(immutable(target));
    if (version >= 4) {
      BY_HANDLE_FILE_INFORMATION actual{};
      if (!GetFileInformationByHandle(image.value, &actual) ||
          CompareFileTime(&actual.ftLastWriteTime, &node.info.ftLastWriteTime))
        throw std::runtime_error("Offline stage timestamp differs");
    }
    const auto checksum = Source::hash(node.handle.value); node.check();
    if (Source::hash(image.value) != checksum) throw std::runtime_error("Offline staged bytes differ from pinned source");
    images.push_back(std::make_unique<Handle>(std::exchange(image.value, nullptr)));
    files.insert(target);
    records.push_back("{\"original\":" + Source::json(origin) + ",\"staged\":" + Source::json(target) +
      ",\"volume\":" + std::to_string(node.info.dwVolumeSerialNumber) + ",\"index\":\"" +
      std::to_string((static_cast<uint64_t>(node.info.nFileIndexHigh) << 32) | node.info.nFileIndexLow) + "\",\"bytes\":" +
      std::to_string(size) + ",\"digest\":\"" + checksum + "\"" +
      (version >= 4 ? ",\"modified\":\"" + std::to_string((static_cast<uint64_t>(node.info.ftLastWriteTime.dwHighDateTime) << 32) |
        node.info.ftLastWriteTime.dwLowDateTime) + "\"" : "") + "}");
  }
};

void recover(const std::wstring& control) {
  const auto file = control + L"\\journal.bin";
  if (!exists(file)) return;
  Handle input(CreateFileW(native(file).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION info{}; LARGE_INTEGER size{};
  if (input.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(input.value, &info) || info.nNumberOfLinks != 1 ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || !GetFileSizeEx(input.value, &size) ||
      size.QuadPart <= 0 || size.QuadPart > 32 * 1024 * 1024) throw std::runtime_error("Offline recovery journal identity refused");
  std::vector<BYTE> cipher(static_cast<size_t>(size.QuadPart)); DWORD count = 0;
  if (!ReadFile(input.value, cipher.data(), static_cast<DWORD>(cipher.size()), &count, nullptr) || count != cipher.size())
    throw std::runtime_error("Offline recovery journal incomplete");
  Envelope saved{protect(cipher, true)};
  if (saved.integer() != 1) throw std::runtime_error("Offline recovery journal version differs");
  const DWORD phase = saved.integer(); if (phase > 1) throw std::runtime_error("Offline recovery phase differs");
  State state; state.control = control; state.generation = saved.text();
  const DWORD guardian = saved.integer(); const auto born = saved.text();
  Handle previous(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, guardian));
  if (!previous.value && GetLastError() != ERROR_INVALID_PARAMETER) throw std::runtime_error("Offline previous guardian death uncertain");
  if (previous.value && birth(previous.value) == number(born.c_str()) && WaitForSingleObject(previous.value, 0) != WAIT_OBJECT_0)
    throw std::runtime_error("Offline previous guardian remains live");
  const DWORD total = saved.integer(); if (total > 16384) throw std::runtime_error("Offline recovery count exceeded bound");
  struct Record {std::wstring path; DWORD directory, volume, high, low; std::wstring sddl;};
  std::vector<Record> records;
  for (DWORD index = 0; index < total; ++index) records.push_back({saved.text(), saved.integer(), saved.integer(), saved.integer(), saved.integer(), saved.text()});
  if (saved.offset != saved.data.size()) throw std::runtime_error("Offline recovery trailing data");
  if (phase == 1) return;
  // Resolve every file-ID first; never partially restore a replaced tree.
  for (const auto& record : records) {
    auto node = std::make_unique<Node>(record.path);
    if (record.directory > 1 || node->directory != (record.directory == 1) || node->info.dwVolumeSerialNumber != record.volume ||
        node->info.nFileIndexHigh != record.high || node->info.nFileIndexLow != record.low)
      throw std::runtime_error("Offline recovery selected object was replaced");
    node->original = record.sddl; node->changed = true; state.nodes.push_back(std::move(node));
  }
  // Release our journal read pin before its atomic restored publication.
  CloseHandle(input.value); input.value = nullptr;
  state.restore();
}

void privateControl(const std::wstring& path) {
  Handle token(nullptr);
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) throw std::runtime_error("Offline current SID unavailable");
  DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  if (!size || size > 65536) throw std::runtime_error("Offline token SID bound invalid");
  std::vector<BYTE> bytes(size);
  if (!GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size)) throw std::runtime_error("Offline token SID unavailable");
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &sid)) throw std::runtime_error("Offline SID serialization failed");
  const std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  Node node(path);
  if (!node.directory) throw std::runtime_error("Offline private control is not a directory");
  node.set(sddl);
  // Control belongs to this generation; its private DACL deliberately remains.
  node.expected = node.security();
  node.check();
}
std::wstring executable() {
  wchar_t file[4097]{};
  const DWORD size = GetModuleFileNameW(nullptr, file, 4097);
  if (!size || size >= 4097) throw std::runtime_error("Offline helper image path unavailable");
  return canonical(file);
}
std::string checksum(const std::wstring& file) {
  Handle image(CreateFileW(native(file).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  if (image.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Offline helper image unavailable");
  return Source::hash(image.value);
}
int launch() {
  auto frame = SourcePipe::input();
  const DWORD version = frame.integer();
  if (version != 1 && version != 2 && version != 3 && version != 4) throw std::runtime_error("Offline launcher protocol invalid");
  frame.integer();
  const auto source = SourcePipe::identity(frame);
  Handle owner(SourcePipe::owned(source));
  if (SourcePipe::parent(GetCurrentProcess()) != source.pid) throw std::runtime_error("Offline launcher exact caller differs");
  const auto file = executable(); const auto digest = checksum(file);
  std::vector<BYTE> bytes; integer(bytes, GetCurrentProcessId()); text(bytes, std::to_wstring(birth(GetCurrentProcess()))); text(bytes, file);
  text(bytes, std::wstring(digest.begin(), digest.end())); bytes.insert(bytes.end(), frame.data.begin(), frame.data.end());
  if (bytes.size() > 32768) throw std::runtime_error("Offline wrapped frame exceeded bound");
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE}; HANDLE inputfd = nullptr, outputfd = nullptr;
  if (!CreatePipe(&inputfd, &outputfd, &security, 32768)) throw std::runtime_error("Offline guardian private stdin unavailable");
  Handle input(inputfd), output(outputfd);
  if (!SetHandleInformation(output.value, HANDLE_FLAG_INHERIT, 0)) throw std::runtime_error("Offline guardian input inheritance refused");
  HANDLE outfd = nullptr, errfd = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &outfd, 0, TRUE, DUPLICATE_SAME_ACCESS))
    throw std::runtime_error("Offline guardian stdout unavailable");
  Handle out(outfd);
  if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &errfd, 0, TRUE, DUPLICATE_SAME_ACCESS))
    throw std::runtime_error("Offline guardian stderr unavailable");
  Handle err(errfd);
  struct Attributes {
    std::vector<BYTE> bytes;
    LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    ~Attributes() {if (value) DeleteProcThreadAttributeList(value);}
  } attributes;
  SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  if (!size || size > 1048576) throw std::runtime_error("Offline guardian handle-list size invalid");
  attributes.bytes.resize(size);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.bytes.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) throw std::runtime_error("Offline guardian handle-list unavailable");
  attributes.value = list;
  HANDLE handles[] = {input.value, out.value, err.value};
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr))
    throw std::runtime_error("Offline guardian exact inherited handles refused");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = input.value; startup.StartupInfo.hStdOutput = out.value; startup.StartupInfo.hStdError = err.value;
  PROCESS_INFORMATION child{}; std::wstring command = L"\"" + file + L"\" profile-offline-guardian";
  if (!CreateProcessW(file.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &child))
    throw std::runtime_error("Offline dedicated guardian launch failed");
  Handle process(child.hProcess), thread(child.hThread);
  CloseHandle(input.value); input.value = nullptr;
  std::vector<BYTE> packet; integer(packet, static_cast<DWORD>(bytes.size())); packet.insert(packet.end(), bytes.begin(), bytes.end());
  DWORD count = 0;
  if (!WriteFile(output.value, packet.data(), static_cast<DWORD>(packet.size()), &count, nullptr) || count != packet.size())
    throw std::runtime_error("Offline guardian initialization incomplete");
  // A native grandchild is not a Bun-managed direct child. Its own original
  // source kernel handle remains authoritative if this relay is torn down.
  while (WaitForSingleObject(process.value, 20) == WAIT_TIMEOUT) {
    DWORD available = 0;
    if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) {
      CloseHandle(output.value); output.value = nullptr;
      WaitForSingleObject(process.value, INFINITE); break;
    }
    if (!available) continue;
    std::vector<BYTE> data(std::min<DWORD>(available, 32768)); DWORD read = 0, written = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), data.data(), static_cast<DWORD>(data.size()), &read, nullptr) ||
        !WriteFile(output.value, data.data(), read, &written, nullptr) || written != read) {
      CloseHandle(output.value); output.value = nullptr;
      WaitForSingleObject(process.value, INFINITE); break;
    }
  }
  DWORD code = STILL_ACTIVE;
  if (!GetExitCodeProcess(process.value, &code) || code == STILL_ACTIVE) throw std::runtime_error("Offline guardian exact native exit unavailable");
  return static_cast<int>(code);
}
int run(bool guarded = false) {
  auto frame = SourcePipe::input();
  Handle relay(nullptr);
  if (guarded) {
    const auto parent = SourcePipe::identity(frame);
    relay.value = SourcePipe::owned(parent);
    const auto file = executable(); const auto digest = checksum(file);
    if (SourcePipe::parent(GetCurrentProcess()) != parent.pid || _wcsicmp(file.c_str(), parent.executable.c_str()) ||
        std::wstring(digest.begin(), digest.end()) != parent.digest) throw std::runtime_error("Offline guardian pinned native relay differs");
  }
  const DWORD version = frame.integer();
  if (version != 1 && version != 2 && version != 3 && version != 4) throw std::runtime_error("Offline protocol version invalid");
  const DWORD operation = frame.integer();
  const auto parent = SourcePipe::identity(frame);
  Handle owner(SourcePipe::owned(parent));
  if (!guarded && SourcePipe::parent(GetCurrentProcess()) != parent.pid) throw std::runtime_error("Offline exact caller parent differs");
  State state; state.version = version; state.control = frame.text(); state.generation = frame.text();
  if (_wcsicmp(canonical(state.control).c_str(), state.control.c_str())) throw std::runtime_error("Offline control canonical path differs");
  if (operation == 2) {
    if (frame.offset != frame.data.size()) throw std::runtime_error("Offline private registry input trailing data");
    privateControl(state.control);
    std::printf("{\"private\":true,\"generation\":%s}\n", Source::json(state.generation).c_str()); return 0;
  }
  if (operation == 1) {
    if (frame.offset != frame.data.size()) throw std::runtime_error("Offline recovery input trailing data");
    recover(state.control); std::printf("{\"recovered\":true,\"generation\":%s}\n", Source::json(state.generation).c_str()); return 0;
  }
  if (operation != 0) throw std::runtime_error("Offline operation invalid");
  const DWORD timeout = frame.integer(); state.maximum = frame.integer(); state.limit = frame.integer();
  const DWORD total = frame.integer();
  if (timeout < 100 || timeout > 300000 || !state.maximum || state.maximum > 16384 || !state.limit || !total || total > 128)
    throw std::runtime_error("Offline limits invalid");
  std::vector<std::pair<std::wstring, DWORD>> roots;
  std::vector<std::vector<std::wstring>> missing;
  for (DWORD index = 0; index < total; ++index) {
    const DWORD kind = frame.integer(); const auto file = frame.text();
    if (kind > (version >= 2 ? 2u : 1u)) throw std::runtime_error("Offline root kind invalid");
    roots.emplace_back(file, kind);
    missing.emplace_back();
    const DWORD count = version >= 2 ? frame.integer() : 0;
    if (count > 128 || (kind == 2 && !count) || (kind != 2 && count)) throw std::runtime_error("Offline negative namespace input invalid");
    for (DWORD item = 0; item < count; ++item) {
      const auto child = frame.text();
      if (!Source::inside(file, child) || !_wcsicmp(file.c_str(), child.c_str()) ||
          _wcsicmp(fs::path(child).lexically_normal().wstring().c_str(), child.c_str())) throw std::runtime_error("Offline negative path escapes namespace");
      missing.back().push_back(child);
    }
  }
  if (frame.offset != frame.data.size()) throw std::runtime_error("Offline input trailing data");
  if (exists(state.control + L"\\journal.bin")) throw std::runtime_error("Offline generation reused");
  std::vector<std::string> maps; std::vector<std::string> failures;
  try {
    privateControl(state.control);
    state.parents(state.control + L"\\image");
    // All proposed namespace fences exclude the private control directory.
    for (size_t index = 0; index < roots.size(); ++index) {
      const auto& root = roots[index];
      if (_wcsicmp(canonical(root.first).c_str(), root.first.c_str())) throw std::runtime_error("Offline selected root changed");
      state.parents(root.first);
      const DWORD attrs = GetFileAttributesW(native(root.first).c_str());
      if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Offline selected root absent/reparse");
      const auto directory = (attrs & FILE_ATTRIBUTE_DIRECTORY) ? root.first : fs::path(root.first).parent_path().wstring();
      if (Source::inside(directory, state.control) || Source::inside(state.control, directory)) {
        if (root.second != 2 || !Source::inside(directory, state.control) || !_wcsicmp(directory.c_str(), state.control.c_str()))
          throw std::runtime_error("Offline private control overlaps selected namespace");
        for (const auto& file : missing[index]) if (Source::inside(file, state.control) || Source::inside(state.control, file))
          throw std::runtime_error("Offline private control overlaps selected namespace");
        state.parents(state.control + L"\\image", directory);
      }
      state.admit(directory);
    }
    const auto absent = [&]() {
      for (const auto& group : missing) for (const auto& file : group) {
        const DWORD attrs = GetFileAttributesW(native(file).c_str());
        const DWORD error = GetLastError();
        if (attrs != INVALID_FILE_ATTRIBUTES || (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND))
          throw std::runtime_error("Offline negative path appeared or is uncertain");
      }
    };
    absent();
    for (size_t index = 0; index < roots.size(); ++index) {
      const auto target = state.control + L"\\image\\" + std::to_wstring(index);
      const bool directory = (GetFileAttributesW(native(roots[index].first).c_str()) & FILE_ATTRIBUTE_DIRECTORY) != 0;
      const auto staged = directory ? target : target + L"\\" + fs::path(roots[index].first).filename().wstring();
      if (roots[index].second == 2) {
        if (!directory) throw std::runtime_error("Offline negative namespace is not a directory");
        // Hold-only: never enumerate or read this original parent or its siblings.
        state.directory(staged);
      } else state.stage(roots[index].first, staged);
      if (roots[index].second == 1) {
        if (directory) throw std::runtime_error("Offline SQLite root is a directory");
        for (const auto suffix : {L"-wal", L"-shm"}) if (exists(roots[index].first + suffix)) state.stage(roots[index].first + suffix, staged + suffix);
      }
      maps.push_back("{\"kind\":\"" + std::string(roots[index].second == 2 ? "negative" : roots[index].second ? "sqlite" : "json") + "\",\"original\":" + Source::json(roots[index].first) +
        ",\"staged\":" + Source::json(staged) + ",\"directory\":" + (directory ? "true" : "false") + "}");
    }
    state.seal();
    state.check();
    std::printf("{\"version\":%lu,\"generation\":%s,\"state\":\"held\",\"roots\":[", version, Source::json(state.generation).c_str());
    for (size_t index = 0; index < maps.size(); ++index) std::printf("%s%s", index ? "," : "", maps[index].c_str());
    std::printf("],\"files\":[");
    for (size_t index = 0; index < state.records.size(); ++index) std::printf("%s%s", index ? "," : "", state.records[index].c_str());
    if (version >= 3) {
      std::printf("],\"directories\":[");
      for (size_t index = 0; index < state.folders.size(); ++index) std::printf("%s%s", index ? "," : "", state.folders[index].c_str());
    }
    const auto file = executable(); const auto digest = checksum(file);
    std::printf("],\"guardian\":{\"pid\":%lu,\"birth\":\"%llu\",\"executable\":%s,\"digest\":\"%s\"},\"portableCaptureAuthorized\":false}\n",
      GetCurrentProcessId(), static_cast<unsigned long long>(birth(GetCurrentProcess())), Source::json(file).c_str(), digest.c_str()); std::fflush(stdout);
    const auto deadline = GetTickCount64() + timeout;
    while (true) {
      state.check();
      absent();
      if (WaitForSingleObject(owner.value, 0) == WAIT_OBJECT_0) {failures.push_back("Offline parent died; callback unavailable"); break;}
      DWORD available = 0;
      if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) throw std::runtime_error("Offline control pipe closed before release");
      if (available >= 4) {
        auto release = SourcePipe::input();
        if (release.integer() != 1 || release.text() != state.generation || release.offset != release.data.size()) throw std::runtime_error("Offline release identity differs");
        break;
      }
      if (GetTickCount64() >= deadline) throw std::runtime_error("Offline held deadline expired");
      Sleep(20);
    }
  } catch (const std::exception& error) {failures.push_back(error.what());}
  bool restored = false;
  try {state.restore(); restored = true;} catch (const std::exception& error) {failures.push_back(error.what());}
  std::printf("{\"version\":%lu,\"generation\":%s,\"state\":\"retired\",\"restored\":%s,\"failures\":[", version, Source::json(state.generation).c_str(), restored ? "true" : "false");
  for (size_t index = 0; index < failures.size(); ++index) std::printf("%s%s", index ? "," : "", Source::json(std::wstring(failures[index].begin(), failures[index].end())).c_str());
  std::printf("],\"portableCaptureAuthorized\":false}\n"); std::fflush(stdout);
  return failures.empty() && restored ? 0 : 1;
}
}
