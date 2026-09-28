// Read-only isolated MTA UI Automation worker. Provider deadlines belong to its parent.
#define NOMINMAX
#include <windows.h>
#include <UIAutomation.h>
#include <wincrypt.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <sstream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
constexpr size_t commandBytes = 144;
constexpr size_t outputBytes = 1048576;
struct Command {
  uint64_t generation = 0;
  HWND window = nullptr;
  DWORD pid = 0;
  RECT rect{};
  std::string identity;
  std::string request;
};

template <class T> T field(const std::array<unsigned char, commandBytes>& bytes, size_t offset) {
  T value{};
  std::memcpy(&value, bytes.data() + offset, sizeof(value));
  return value;
}
bool parse(const std::array<unsigned char, commandBytes>& bytes, Command& command) {
  if (std::memcmp(bytes.data(), "RYSM", 4) || field<uint32_t>(bytes, 4) != 1 ||
      field<uint32_t>(bytes, 8) != commandBytes) return false;
  command.generation = field<uint64_t>(bytes, 12);
  command.window = reinterpret_cast<HWND>(static_cast<uintptr_t>(field<uint64_t>(bytes, 20)));
  command.pid = field<uint32_t>(bytes, 28);
  command.rect = {field<LONG>(bytes, 32), field<LONG>(bytes, 36), field<LONG>(bytes, 40), field<LONG>(bytes, 44)};
  command.identity.assign(reinterpret_cast<const char*>(bytes.data() + 48), 64);
  command.request.assign(reinterpret_cast<const char*>(bytes.data() + 112), 32);
  return command.generation > 0 && command.generation <= 9007199254740991ULL && command.window && command.pid &&
    static_cast<int64_t>(command.rect.right) - command.rect.left > 0 &&
    static_cast<int64_t>(command.rect.right) - command.rect.left <= 32768 &&
    static_cast<int64_t>(command.rect.bottom) - command.rect.top > 0 &&
    static_cast<int64_t>(command.rect.bottom) - command.rect.top <= 32768 &&
    std::all_of(command.identity.begin(), command.identity.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'); }) &&
    std::all_of(command.request.begin(), command.request.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
std::string utf8(const wchar_t* text, int count) {
  if (count < 0 || count > 512) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, count, nullptr, 0, nullptr, nullptr);
  if (size <= 0 || size > 2048) return {};
  std::string value(static_cast<size_t>(size), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, count, value.data(), size, nullptr, nullptr)) return {};
  return value;
}
std::string quote(const std::string& text) {
  std::string result = "\"";
  constexpr char hex[] = "0123456789ABCDEF";
  for (const unsigned char c : text) {
    if (c == '\"' || c == '\\') { result += '\\'; result += static_cast<char>(c); continue; }
    if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; continue; }
    result += static_cast<char>(c);
  }
  return result + "\"";
}
std::string hash(const std::string& source) {
  HCRYPTPROV provider = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return {};
  HCRYPTHASH digest = 0;
  std::array<BYTE, 32> bytes{};
  DWORD size = static_cast<DWORD>(bytes.size());
  const bool created = CryptCreateHash(provider, CALG_SHA_256, 0, 0, &digest) != 0;
  const bool valid = created && CryptHashData(digest, reinterpret_cast<const BYTE*>(source.data()),
    static_cast<DWORD>(source.size()), 0) && CryptGetHashParam(digest, HP_HASHVAL, bytes.data(), &size, 0);
  if (created) CryptDestroyHash(digest);
  CryptReleaseContext(provider, 0);
  if (!valid || size != bytes.size()) return {};
  constexpr char hex[] = "0123456789ABCDEF";
  std::string value;
  for (const BYTE byte : bytes) { value += hex[byte >> 4]; value += hex[byte & 15]; }
  return value;
}
bool named(HDESK desktop) {
  wchar_t name[128]{};
  DWORD bytes = 0;
  return desktop && GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &bytes) &&
    bytes >= sizeof(wchar_t) && bytes <= sizeof(name) && !std::wcscmp(name, L"Default");
}
bool desktop() {
  if (!named(GetThreadDesktop(GetCurrentThreadId()))) return false;
  const HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!input) return false;
  const bool valid = named(input);
  CloseDesktop(input);
  return valid;
}
bool exact(const Command& command) {
  if (!desktop()) return false;
  if (!IsWindow(command.window) || !IsWindowVisible(command.window) || GetForegroundWindow() != command.window) return false;
  DWORD pid = 0;
  if (!GetWindowThreadProcessId(command.window, &pid) || pid != command.pid) return false;
  RECT rect{};
  if (!GetWindowRect(command.window, &rect)) return false;
  const LONG left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  rect.left = std::max(rect.left, left); rect.top = std::max(rect.top, top);
  rect.right = std::min(rect.right, left + GetSystemMetrics(SM_CXVIRTUALSCREEN));
  rect.bottom = std::min(rect.bottom, top + GetSystemMetrics(SM_CYVIRTUALSCREEN));
  if (std::memcmp(&rect, &command.rect, sizeof(rect))) return false;
  wchar_t cls[512]{};
  const int length = GetClassNameW(command.window, cls, 512);
  if (!length || length == 511) return false;
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  FILETIME creation{}, exit{}, kernel{}, user{};
  const bool valid = GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0;
  CloseHandle(process);
  if (!valid) return false;
  const uint64_t ticks = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  const auto name = utf8(cls, length);
  if (name.empty()) return false;
  std::string source = "pid:" + std::to_string(pid) + ";start:" + std::to_string(ticks + 504911232000000000ULL) + ";class:" + name;
  const auto instance = reinterpret_cast<uintptr_t>(GetPropW(command.window, L"RayaDesktopWindowInstanceV1_74CB301759F7435B9AD54D283319FF5B"));
  if (instance) source += ";instance:" + std::to_string(instance);
  return hash(source) == command.identity;
}
std::string viewport(const RECT& rect) {
  return "{\"x\":" + std::to_string(rect.left) + ",\"y\":" + std::to_string(rect.top) +
    ",\"width\":" + std::to_string(rect.right - rect.left) + ",\"height\":" + std::to_string(rect.bottom - rect.top) + "}";
}
bool emit(const std::string& text) {
  if (text.size() >= outputBytes) return false;
  const std::string line = text + "\n";
  DWORD written = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr) && written == line.size();
}
bool flag(IUIAutomationElement* item, PROPERTYID id, bool& value) {
  VARIANT result{};
  const HRESULT status = item->GetCachedPropertyValue(id, &result);
  const bool valid = SUCCEEDED(status) && result.vt == VT_BOOL;
  if (valid) value = result.boolVal != VARIANT_FALSE;
  VariantClear(&result);
  return valid;
}
bool privateRole(CONTROLTYPEID role, bool password) {
  return password || role == UIA_EditControlTypeId || role == UIA_DocumentControlTypeId;
}
std::string label(IUIAutomationElement* item, PROPERTYID id, UINT limit) {
  VARIANT value{};
  if (FAILED(item->GetCurrentPropertyValue(id, &value))) return {};
  const std::string result = value.vt == VT_BSTR && SysStringLen(value.bstrVal) <= limit
    ? utf8(value.bstrVal, static_cast<int>(SysStringLen(value.bstrVal))) : std::string{};
  VariantClear(&value);
  return result;
}
std::string role(CONTROLTYPEID value) {
  static const char* names[] = {"Button","Calendar","CheckBox","ComboBox","Edit","Hyperlink","Image","ListItem","List","Menu","MenuBar","MenuItem","ProgressBar","RadioButton","ScrollBar","Slider","Spinner","StatusBar","Tab","TabItem","Text","ToolBar","ToolTip","Tree","TreeItem","Custom","Group","Thumb","DataGrid","DataItem","Document","SplitButton","Window","Pane","Header","HeaderItem","Table","TitleBar","Separator","SemanticZoom","AppBar"};
  if (value < UIA_ButtonControlTypeId || value > UIA_AppBarControlTypeId) return "Custom";
  return names[value - UIA_ButtonControlTypeId];
}
struct Observation { std::string controls = "[]"; bool available = false; bool truncated = false; };
std::string runtime(SAFEARRAY* array) {
  VARTYPE type = VT_EMPTY;
  if (!array || FAILED(SafeArrayGetVartype(array, &type)) || type != VT_I4 || SafeArrayGetElemsize(array) != sizeof(int)) return {};
  LONG lower = 0, upper = -1;
  if (SafeArrayGetDim(array) != 1 || FAILED(SafeArrayGetLBound(array, 1, &lower)) ||
      FAILED(SafeArrayGetUBound(array, 1, &upper))) return {};
  const int64_t length = static_cast<int64_t>(upper) - lower + 1;
  if (length <= 0 || length > 32) return {};
  std::string id;
  for (unsigned offset = 0; offset < static_cast<unsigned>(length); ++offset) {
    const int64_t position = static_cast<int64_t>(lower) + offset;
    if (position < LONG_MIN || position > LONG_MAX) return {};
    LONG index = static_cast<LONG>(position);
    int value = 0;
    if (FAILED(SafeArrayGetElement(array, &index, &value))) return {};
    if (!id.empty()) id += '.';
    id += std::to_string(value);
  }
  return id.size() <= 200 ? id : std::string{};
}
Observation collect(IUIAutomation* automation, const Command& command) {
  Observation result;
  ComPtr<IUIAutomationCacheRequest> cache;
  if (FAILED(automation->CreateCacheRequest(&cache))) return result;
  const PROPERTYID properties[] = {UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId, UIA_IsEnabledPropertyId,
    UIA_HasKeyboardFocusPropertyId, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
    UIA_IsInvokePatternAvailablePropertyId, UIA_IsSelectionItemPatternAvailablePropertyId, UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId, UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsScrollItemPatternAvailablePropertyId};
  for (const auto property : properties) if (FAILED(cache->AddProperty(property))) return result;
  if (FAILED(cache->put_TreeScope(TreeScope_Element))) return result;
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(automation->get_ControlViewWalker(&walker)) || !walker) return result;
  ComPtr<IUIAutomationElement> root;
  if (FAILED(automation->ElementFromHandleBuildCache(command.window, cache.Get(), &root)) || !root) return result;
  struct Entry { ComPtr<IUIAutomationElement> item; unsigned depth; bool secret; };
  std::deque<Entry> queue;
  queue.push_back({root, 0, false});
  std::string controls = "[";
  unsigned visited = 0, count = 0;
  while (!queue.empty() && visited < 1024 && count < 256) {
    Entry entry = std::move(queue.front()); queue.pop_front(); ++visited;
    ComPtr<IUIAutomationElement> item;
    if (FAILED(entry.item->BuildUpdatedCache(cache.Get(), &item)) || !item) return result;
    CONTROLTYPEID type = 0;
    bool password = true, enabled = false, focused = false, offscreen = true;
    if (FAILED(item->get_CachedControlType(&type)) || !flag(item.Get(), UIA_IsPasswordPropertyId, password)) return result;
    const bool secret = entry.secret || privateRole(type, password);
    const unsigned room = 1024 - visited - static_cast<unsigned>(queue.size());
    ComPtr<IUIAutomationElement> child;
    if (FAILED(walker->GetFirstChildElementBuildCache(item.Get(), cache.Get(), &child))) return Observation{};
    unsigned admitted = 0;
    while (child && entry.depth < 32 && admitted < room) {
      queue.push_back({child, entry.depth + 1, secret});
      ++admitted;
      ComPtr<IUIAutomationElement> next;
      if (FAILED(walker->GetNextSiblingElementBuildCache(child.Get(), cache.Get(), &next))) return Observation{};
      child = std::move(next);
    }
    if (child) result.truncated = true;
    RECT bounds{};
    if (!flag(item.Get(), UIA_IsOffscreenPropertyId, offscreen) || offscreen ||
        FAILED(item->get_CachedBoundingRectangle(&bounds)) || bounds.right <= bounds.left || bounds.bottom <= bounds.top ||
        bounds.left >= command.rect.right || bounds.top >= command.rect.bottom || bounds.right <= command.rect.left || bounds.bottom <= command.rect.top) continue;
    if (!flag(item.Get(), UIA_IsEnabledPropertyId, enabled) || !flag(item.Get(), UIA_HasKeyboardFocusPropertyId, focused)) return Observation{};
    SAFEARRAY* array = nullptr;
    if (FAILED(item->GetRuntimeId(&array)) || !array) return Observation{};
    const auto id = runtime(array);
    SafeArrayDestroy(array);
    if (id.empty() || id.size() > 200) continue;
    std::string actions = "[";
    const PROPERTYID flags[] = {UIA_IsInvokePatternAvailablePropertyId, UIA_IsSelectionItemPatternAvailablePropertyId,
      UIA_IsTogglePatternAvailablePropertyId, UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId, UIA_IsScrollPatternAvailablePropertyId};
    const char* names[] = {"invoke", "select", "toggle", "expand_collapse", "value", "scroll"};
    bool first = true;
    for (unsigned index = 0; index < 6; ++index) {
      bool present = false;
      if (!flag(item.Get(), flags[index], present)) return Observation{};
      if (index == 5 && !present && !flag(item.Get(), UIA_IsScrollItemPatternAvailablePropertyId, present)) return Observation{};
      if (!present) continue;
      if (!first) actions += ',';
      actions += quote(names[index]); first = false;
    }
    actions += ']';
    const auto name = secret || entry.depth == 0 ? std::string{} : label(item.Get(), UIA_NamePropertyId, 512);
    const auto automationID = secret ? std::string{} : label(item.Get(), UIA_AutomationIdPropertyId, 200);
    if (count) controls += ',';
    controls += "{\"controlID\":" + quote(id) + ",\"role\":" + quote(role(type)) +
      ",\"x\":" + std::to_string(bounds.left) + ",\"y\":" + std::to_string(bounds.top) +
      ",\"width\":" + std::to_string(static_cast<int64_t>(bounds.right) - bounds.left) +
      ",\"height\":" + std::to_string(static_cast<int64_t>(bounds.bottom) - bounds.top) +
      ",\"enabled\":" + (enabled ? "true" : "false") + ",\"focused\":" + (focused ? "true" : "false") + ",\"actions\":" + actions;
    if (!name.empty()) controls += ",\"name\":" + quote(name);
    if (!automationID.empty()) controls += ",\"automationID\":" + quote(automationID);
    controls += '}'; ++count;
    if (controls.size() > outputBytes - 8192) return Observation{};
  }
  result.available = true; result.truncated = result.truncated || !queue.empty(); result.controls = controls + ']';
  return result;
}
std::string error(const Command& command, const char* code) {
  return "{\"version\":1,\"request\":" + quote(command.request) + ",\"generation\":" + std::to_string(command.generation) +
    ",\"type\":\"error\",\"code\":" + quote(code) + "}";
}
bool observe(IUIAutomation* automation, const Command& command, LONGLONG frequency) {
  if (!exact(command)) return emit(error(command, "target_changed"));
  LARGE_INTEGER calibration{}, acquisition{}, prepared{};
  if (!QueryPerformanceCounter(&calibration) || !emit("{\"version\":1,\"type\":\"clock\",\"request\":" + quote(command.request) +
      ",\"generation\":" + std::to_string(command.generation) + ",\"qpc\":\"" + std::to_string(calibration.QuadPart) +
      "\",\"frequency\":\"" + std::to_string(frequency) + "\"}")) return false;
  if (!QueryPerformanceCounter(&acquisition) || acquisition.QuadPart < calibration.QuadPart) return false;
  const auto result = collect(automation, command);
  if (!exact(command)) return emit(error(command, "target_changed"));
  if (!QueryPerformanceCounter(&prepared) || prepared.QuadPart < acquisition.QuadPart) return false;
  std::ostringstream window; window << "0x" << std::hex << std::uppercase << reinterpret_cast<uintptr_t>(command.window);
  const auto rect = viewport(command.rect);
  return emit("{\"version\":1,\"request\":" + quote(command.request) + ",\"generation\":" + std::to_string(command.generation) +
    ",\"windowID\":" + quote(window.str()) + ",\"identity\":" + quote(command.identity) + ",\"viewport\":" + rect +
    ",\"clock\":{\"version\":1,\"acquisition\":\"" + std::to_string(acquisition.QuadPart) + "\",\"prepared\":\"" +
    std::to_string(prepared.QuadPart) + "\",\"frequency\":\"" + std::to_string(frequency) + "\"},\"semantics\":{\"source\":\"windows_ui_automation\",\"status\":\"" +
    (result.available ? "available" : "unavailable") + "\",\"viewport\":" + rect + ",\"controls\":" + result.controls +
    ",\"truncated\":" + (result.truncated && result.available ? "true" : "false") + "}}");
}
int selftest() {
  SAFEARRAYBOUND bound{1, LONG_MAX};
  SAFEARRAY* array = SafeArrayCreate(VT_I4, 1, &bound);
  if (!array) return 7;
  LONG index = LONG_MAX;
  int value = 42;
  const bool extreme = SUCCEEDED(SafeArrayPutElement(array, &index, &value)) && runtime(array) == "42";
  SafeArrayDestroy(array);
  if (!extreme) return 8;
  bound = {1, 0};
  array = SafeArrayCreate(VT_BSTR, 1, &bound);
  if (!array) return 9;
  const bool rejected = runtime(array).empty();
  SafeArrayDestroy(array);
  if (!rejected) return 10;
  std::array<unsigned char, commandBytes> bytes{};
  Command command;
  if (parse(bytes, command)) return 1;
  std::memcpy(bytes.data(), "RYSM", 4);
  const uint32_t version = 1, size = 144, pid = 1;
  const uint64_t generation = 1, window = 1;
  const LONG right = 100, bottom = 200;
  std::memcpy(bytes.data() + 4, &version, 4); std::memcpy(bytes.data() + 8, &size, 4);
  std::memcpy(bytes.data() + 12, &generation, 8); std::memcpy(bytes.data() + 20, &window, 8);
  std::memcpy(bytes.data() + 28, &pid, 4); std::memcpy(bytes.data() + 40, &right, 4); std::memcpy(bytes.data() + 44, &bottom, 4);
  std::memset(bytes.data() + 48, 'A', 64); std::memset(bytes.data() + 112, 'a', 32);
  if (!parse(bytes, command) || !privateRole(UIA_EditControlTypeId, false) || !privateRole(UIA_ButtonControlTypeId, true) ||
      privateRole(UIA_ButtonControlTypeId, false) || quote("a\n\"") != "\"a\\u000A\\\"\"" || hash("abc") != "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD") return 2;
  bytes[48] = 'a'; if (parse(bytes, command)) return 3; bytes[48] = 'A';
  bytes[119] = 'Z'; if (parse(bytes, command)) return 4; bytes[119] = 'a';
  bytes[18] = 255; if (parse(bytes, command)) return 5;
  return emit("{\"version\":1,\"selftest\":\"passed\"}") ? 0 : 6;
}
int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (argc != 2) return 2;
  if (!std::wcscmp(argv[1], L"--self-test")) return selftest();
  if (!std::wcscmp(argv[1], L"--protocol")) return emit("{\"version\":1,\"operation\":\"semantic\",\"commandBytes\":144,\"maxOutputBytes\":1048576,\"clock\":1}") ? 0 : 2;
  LARGE_INTEGER frequency{}, qpc{};
  if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0) return 2;
  if (!std::wcscmp(argv[1], L"--clock-v1")) {
    if (!QueryPerformanceCounter(&qpc)) return 2;
    return emit("{\"version\":1,\"type\":\"clock\",\"qpc\":\"" + std::to_string(qpc.QuadPart) + "\",\"frequency\":\"" + std::to_string(frequency.QuadPart) + "\"}") ? 0 : 2;
  }
  if (std::wcscmp(argv[1], L"--serve-v1")) return 2;
  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return 2;
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;
  ComPtr<IUIAutomation> automation;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)))) { CoUninitialize(); return 2; }
  if (!emit("{\"version\":1,\"type\":\"ready\"}")) { automation.Reset(); CoUninitialize(); return 2; }
  int status = 0;
  for (;;) {
    std::array<unsigned char, commandBytes> bytes{};
    DWORD offset = 0;
    while (offset < bytes.size()) {
      DWORD count = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data() + offset, static_cast<DWORD>(bytes.size()) - offset, &count, nullptr) || !count) {
        status = offset ? 2 : 0; break;
      }
      offset += count;
    }
    if (offset != bytes.size()) break;
    Command command;
    if (!parse(bytes, command)) { status = 2; break; }
    if (!observe(automation.Get(), command, frequency.QuadPart)) { status = 2; break; }
  }
  automation.Reset(); CoUninitialize(); return status;
}
