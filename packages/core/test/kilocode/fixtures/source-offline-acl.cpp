#define wmain source_host_main
#include "../../../native/kilocode/process-host.cpp"
#undef wmain

int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || argv[1][1] != L':') return source_host_main(argc, argv);
  if (argc != 2) return 2;
  try {
    const std::wstring root(argv[1]);
    for (const auto& flags : {L"", L"AI", L"P", L"PAI"}) {
      const auto dir = root + L"\\" + (std::wstring(flags).empty() ? L"legacy" : flags);
      if (!CreateDirectoryW(Offline::native(dir).c_str(), nullptr)) return 3;
      Offline::Node parent(dir);
      parent.set(L"D:" + std::wstring(flags) + parent.original.substr(parent.original.find(L'(')));
      const auto before = parent.security();
      if (before.substr(0, before.find(L'(')) != L"D:" + std::wstring(flags)) {
        std::fprintf(stderr, "Native initial ACL flags %ls\n", before.substr(0, before.find(L'(')).c_str()); return 4;
      }
      const auto path = dir + L"\\child";
      if (!CreateDirectoryW(Offline::native(path).c_str(), nullptr)) return 5;
      Offline::Node child(path);
      const auto descendant = child.security();
      parent.original = before;
      parent.fence();
      parent.check();
      if (child.security() != descendant) return 6;
      const auto file = dir + L"\\blocked.bin";
      Handle writer(CreateFileW(Offline::native(file).c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
      if (writer.value != INVALID_HANDLE_VALUE || GetLastError() != ERROR_ACCESS_DENIED) return 7;
      parent.restore();
      if (parent.security() != before || child.security() != descendant) return 8;
      child.check();
      parent.fence();
      parent.restore();
      if (parent.security() != before || child.security() != descendant) return 9;
      std::printf("Offline exact ACL roundtrip %ls\n", *flags ? flags : L"legacy");
    }
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what()); return 1;
  }
}
