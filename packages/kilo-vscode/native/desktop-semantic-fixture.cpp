// Actual Windows providers on an isolated desktop that is never activated.
#define wmain semantic_main
#include "desktop-semantic.cpp"
#undef wmain

class Provider final : public IRawElementProviderSimple {
  LONG refs = 1;
public:
  HWND window = nullptr;
  std::wstring witness;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (id != __uuidof(IUnknown) && id != __uuidof(IRawElementProviderSimple)) return E_NOINTERFACE;
    *value = static_cast<IRawElementProviderSimple*>(this); AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&refs)); }
  ULONG STDMETHODCALLTYPE Release() override {
    const LONG value = InterlockedDecrement(&refs);
    if (!value) delete this;
    return static_cast<ULONG>(value);
  }
  HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* value) override {
    if (!value) return E_POINTER;
    *value = ProviderOptions_ServerSideProvider; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID, IUnknown** value) override {
    if (!value) return E_POINTER;
    *value = nullptr; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID, VARIANT* value) override {
    if (!value) return E_POINTER;
    VariantInit(value);
    if (witness.empty()) emit("{\"version\":1,\"fixture\":\"provider_entered\"}");
    if (!witness.empty()) {
      const HANDLE file = CreateFileW(witness.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (file == INVALID_HANDLE_VALUE) return E_FAIL;
      const std::string marker = "pid:" + std::to_string(GetCurrentProcessId()) + ";provider_entered";
      DWORD written = 0;
      const bool valid = WriteFile(file, marker.data(), static_cast<DWORD>(marker.size()), &written, nullptr) && written == marker.size() && FlushFileBuffers(file);
      CloseHandle(file);
      if (!valid) return E_FAIL;
    }
    Sleep(INFINITE); return E_FAIL;
  }
  HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** value) override {
    return UiaHostProviderFromHwnd(window, value);
  }
};

struct Fixture {
  HDESK desktop = nullptr;
  HANDLE ready = nullptr;
  HWND window = nullptr;
  HWND button = nullptr;
  HWND edit = nullptr;
  DWORD tid = 0;
  bool hang = false;
  std::wstring witness;
  static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_GETOBJECT && static_cast<LONG>(lparam) == UiaRootObjectId) {
      auto* provider = reinterpret_cast<Provider*>(GetWindowLongPtrW(window, GWLP_USERDATA));
      if (provider) return UiaReturnRawElementProvider(window, wparam, lparam, provider);
    }
    return DefWindowProcW(window, message, wparam, lparam);
  }
  static DWORD WINAPI run(void* pointer) {
    auto& fixture = *static_cast<Fixture*>(pointer);
    fixture.tid = GetCurrentThreadId();
    if (!SetThreadDesktop(fixture.desktop)) { SetEvent(fixture.ready); return 1; }
    WNDCLASSW cls{};
    cls.lpfnWndProc = procedure; cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = L"RayaSemanticPrivateProvider";
    if (fixture.hang && !RegisterClassW(&cls)) { SetEvent(fixture.ready); return 1; }
    fixture.window = CreateWindowExW(0, fixture.hang ? cls.lpszClassName : L"STATIC", L"Private semantic fixture", WS_POPUP | WS_VISIBLE,
      0, 0, 600, 400, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    Provider* provider = fixture.hang && fixture.window ? new Provider() : nullptr;
    if (provider) { provider->window = fixture.window; provider->witness = fixture.witness; SetWindowLongPtrW(fixture.window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(provider)); }
    if (fixture.window) {
      fixture.button = CreateWindowExW(0, L"BUTTON", L"Safe fixture button", WS_CHILD | WS_VISIBLE,
        20, 20, 180, 40, fixture.window, nullptr, GetModuleHandleW(nullptr), nullptr);
      fixture.edit = CreateWindowExW(0, L"EDIT", L"RAYA_PRIVATE_SECRET_7821", WS_CHILD | WS_VISIBLE | ES_PASSWORD,
        20, 80, 180, 40, fixture.window, nullptr, GetModuleHandleW(nullptr), nullptr);
    }
    SetEvent(fixture.ready);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message); DispatchMessageW(&message);
    }
    if (fixture.window) DestroyWindow(fixture.window);
    if (provider) provider->Release();
    return 0;
  }
};
int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return 1;
  Fixture fixture;
  const bool serve = argc == 3 && !std::wcscmp(argv[1], L"--serve-hang") && std::wcslen(argv[2]) > 0 && std::wcslen(argv[2]) < 32768;
  fixture.hang = serve || (argc == 2 && !std::wcscmp(argv[1], L"--hang"));
  if (serve) fixture.witness = argv[2];
  if (argc > 1 && !fixture.hang) return 2;
  const std::wstring name = L"RayaSemanticPrivate_" + std::to_wstring(GetCurrentProcessId());
  fixture.desktop = CreateDesktopW(name.c_str(), nullptr, nullptr, 0, DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS, nullptr);
  fixture.ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!fixture.desktop || !fixture.ready) return 2;
  HANDLE thread = CreateThread(nullptr, 0, Fixture::run, &fixture, 0, nullptr);
  if (!thread || WaitForSingleObject(fixture.ready, 5000) != WAIT_OBJECT_0 || !fixture.window || !fixture.button || !fixture.edit) return 3;
  const HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(init)) return 4;
  ComPtr<IUIAutomation> automation;
  const HRESULT created = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
  Command command;
  command.window = fixture.window; command.rect = {0, 0, 600, 400};
  if (serve) {
    if (FAILED(created) || !emit("{\"version\":1,\"type\":\"ready\"}")) return 8;
    std::array<unsigned char, commandBytes> bytes{};
    DWORD offset = 0;
    while (offset < bytes.size()) {
      DWORD count = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data() + offset, static_cast<DWORD>(bytes.size()) - offset, &count, nullptr) || !count) return 9;
      offset += count;
    }
    Command received;
    if (!parse(bytes, received)) return 10;
    LARGE_INTEGER qpc{}, frequency{};
    if (!QueryPerformanceCounter(&qpc) || !QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0) return 11;
    if (!emit("{\"version\":1,\"type\":\"clock\",\"request\":" + quote(received.request) + ",\"generation\":" +
      std::to_string(received.generation) + ",\"qpc\":\"" + std::to_string(qpc.QuadPart) + "\",\"frequency\":\"" + std::to_string(frequency.QuadPart) + "\"}")) return 12;
  }
  const auto result = SUCCEEDED(created) ? collect(automation.Get(), command) : Observation{};
  // Production foreground enforcement must reject this private, never-activated target.
  const bool refused = !exact(command);
  automation.Reset(); CoUninitialize();
  PostThreadMessageW(fixture.tid, WM_QUIT, 0, 0);
  if (WaitForSingleObject(thread, 5000) != WAIT_OBJECT_0) return 5;
  CloseHandle(thread); CloseHandle(fixture.ready); CloseDesktop(fixture.desktop);
  if (!result.available || result.controls.find("Safe fixture button") == std::string::npos ||
      result.controls.find("RAYA_PRIVATE_SECRET_7821") != std::string::npos ||
      result.controls.find("\"role\":\"Edit\"") == std::string::npos || !refused) return 6;
  return emit("{\"version\":1,\"fixture\":\"passed\",\"privateDesktop\":true,\"secretRedacted\":true,\"foregroundRefused\":true}") ? 0 : 7;
}
