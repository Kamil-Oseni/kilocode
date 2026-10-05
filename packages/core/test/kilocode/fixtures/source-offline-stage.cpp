#define wmain source_host_main
#include "../../../native/kilocode/process-host.cpp"
#undef wmain

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  const std::wstring root(argv[1]);
  const auto file = root + L"\\stage.bin";
  try {
    {
      Handle output(CreateFileW(Offline::native(file).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
      const BYTE bytes[] = {0, 255, 42}; DWORD count = 0;
      if (output.value == INVALID_HANDLE_VALUE || !WriteFile(output.value, bytes, sizeof(bytes), &count, nullptr) || count != sizeof(bytes) || !FlushFileBuffers(output.value)) return 3;
    }
    {
      Handle image(Offline::immutable(file));
      BYTE bytes[3]{}; DWORD count = 0;
      if (!ReadFile(image.value, bytes, sizeof(bytes), &count, nullptr) || count != sizeof(bytes) || bytes[1] != 255) return 4;
      std::puts("Offline immutable stage success");
    }
    {
      Handle writer(CreateFileW(Offline::native(file).c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
      if (writer.value == INVALID_HANDLE_VALUE) return 5;
      try { Handle image(Offline::immutable(file)); return 6; }
      catch (const std::exception& error) {
        if (std::string(error.what()) != "Offline immutable stage sharing refused") return 7;
        std::puts(error.what());
      }
    }
    try { Handle image(Offline::immutable(root + L"\\missing.bin")); return 8; }
    catch (const std::exception& error) {
      if (std::string(error.what()) != "Offline immutable stage missing refused") return 9;
      std::puts(error.what());
    }
    // A directory handle requires BACKUP_SEMANTICS; the production regular-file open must refuse it.
    try { Handle image(Offline::immutable(root)); return 10; }
    catch (const std::exception& error) {
      if (std::string(error.what()) != "Offline immutable stage access refused") return 11;
      std::puts(error.what());
    }
    { Handle image(Offline::immutable(file)); }
    if (!DeleteFileW(Offline::native(file).c_str())) return 12;
    std::puts("Offline immutable stage handles closed");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what()); return 1;
  }
}
