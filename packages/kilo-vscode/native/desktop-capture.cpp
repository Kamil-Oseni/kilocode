// Experimental native capture host, launched only by the explicit Windows candidate switch.
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

static constexpr UINT kPixels = 8'294'400;
static constexpr UINT kEdge = 4'096;
static constexpr DWORD kImageBytes = 15'000'000;
static constexpr UINT kPointerEdge = 1'024;
static constexpr UINT kPointerBytes = 4 * 1'024 * 1'024;
static constexpr UINT kOutputs = 8;
static volatile LONG stopped = 0;
static volatile LONG faulting = 0;

static LONG WINAPI fault(EXCEPTION_POINTERS* info) {
  if (InterlockedCompareExchange(&faulting, 1, 0) || !info || !info->ExceptionRecord)
    return EXCEPTION_EXECUTE_HANDLER;
  const auto address = reinterpret_cast<uintptr_t>(info->ExceptionRecord->ExceptionAddress);
  MEMORY_BASIC_INFORMATION memory{};
  const auto found = VirtualQuery(info->ExceptionRecord->ExceptionAddress, &memory, sizeof(memory));
  const auto base = found ? reinterpret_cast<uintptr_t>(memory.AllocationBase) : 0;
  const auto main = base && memory.AllocationBase == GetModuleHandleW(nullptr);
  char module[49] = "unknown";
  if (main) {
    std::memcpy(module, "main", 5);
  } else if (base) {
    wchar_t path[MAX_PATH]{};
    const DWORD count = GetModuleFileNameW(reinterpret_cast<HMODULE>(base), path, MAX_PATH);
    if (count && count < MAX_PATH) {
      DWORD start = 0;
      for (DWORD index = 0; index < count; ++index)
        if (path[index] == L'\\' || path[index] == L'/') start = index + 1;
      const DWORD length = std::min<DWORD>(count - start, sizeof(module) - 1);
      for (DWORD index = 0; index < length; ++index) {
        const wchar_t c = path[start + index];
        module[index] = (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z') ||
                        (c >= L'0' && c <= L'9') || c == L'.' || c == L'_' || c == L'-' ? char(c) : '_';
      }
      module[length] = 0;
    }
  }
  char header[256]{};
  const int count = std::snprintf(header, sizeof(header),
    "{\"v\":1,\"type\":\"error\",\"code\":\"native_fault\",\"fault\":\"%08lX:%s+0x%llX\"}",
    info->ExceptionRecord->ExceptionCode, module,
    static_cast<unsigned long long>(base && address >= base ? address - base : 0));
  if (count <= 0 || count >= int(sizeof(header))) return EXCEPTION_EXECUTE_HANDLER;
  const HANDLE pipe = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!pipe || pipe == INVALID_HANDLE_VALUE) return EXCEPTION_EXECUTE_HANDLER;
  const uint32_t length = uint32_t(count);
  const uint32_t empty = 0;
  DWORD written = 0;
  WriteFile(pipe, &length, sizeof(length), &written, nullptr);
  WriteFile(pipe, header, length, &written, nullptr);
  WriteFile(pipe, &empty, sizeof(empty), &written, nullptr);
  return EXCEPTION_EXECUTE_HANDLER;
}

struct Failure : std::runtime_error {
  std::string code;
  Failure(const char* value, const char* detail) : std::runtime_error(detail), code(value) {}
};

static double ms(Clock::time_point begin, Clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - begin).count();
}

static void require(HRESULT result, const char* operation) {
  if (SUCCEEDED(result)) return;
  char buffer[160];
  std::snprintf(buffer, sizeof(buffer), "%s failed (HRESULT 0x%08X)", operation, unsigned(result));
  if (result == DXGI_ERROR_ACCESS_LOST || result == DXGI_ERROR_DEVICE_REMOVED ||
      result == DXGI_ERROR_DEVICE_RESET || result == DXGI_ERROR_DEVICE_HUNG)
    throw Failure("device_lost", buffer);
  throw Failure("capture_failed", buffer);
}

static std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), int(value.size()), nullptr, 0, nullptr, nullptr);
  if (!count) throw std::runtime_error("foreground title is not valid Unicode");
  std::string result(size_t(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), int(value.size()), result.data(), count, nullptr, nullptr) != count)
    throw std::runtime_error("foreground title conversion failed");
  return result;
}

static std::string quoted(const std::string& value) {
  std::string result = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { result += '\\'; result += char(c); continue; }
    if (c < 0x20) {
      char escape[7];
      std::snprintf(escape, sizeof(escape), "\\u%04X", c);
      result += escape;
      continue;
    }
    result += char(c);
  }
  return result + '"';
}

static void write(HANDLE pipe, const void* data, DWORD bytes) {
  auto cursor = static_cast<const unsigned char*>(data);
  while (bytes) {
    DWORD count = 0;
    if (!WriteFile(pipe, cursor, bytes, &count, nullptr) || !count) throw std::runtime_error("stdout pipe closed");
    cursor += count;
    bytes -= count;
  }
}

static void packet(HANDLE pipe, const std::string& header, const void* image, DWORD bytes) {
  if (header.empty() || header.size() > 4096 || bytes > kImageBytes) throw std::runtime_error("capture packet exceeds protocol bounds");
  uint32_t length = uint32_t(header.size());
  write(pipe, &length, sizeof(length));
  write(pipe, header.data(), length);
  write(pipe, &bytes, sizeof(bytes));
  if (bytes) write(pipe, image, bytes);
}

static bool terminal(HANDLE pipe, const std::string& code) noexcept {
  try {
    packet(pipe, "{\"v\":1,\"type\":\"error\",\"code\":" + quoted(code) + '}', nullptr, 0);
    return true;
  } catch (...) {
    return false;
  }
}

static DWORD pngsize(const std::vector<unsigned char>& bytes) {
  constexpr unsigned char signature[]{137, 80, 78, 71, 13, 10, 26, 10};
  if (std::memcmp(bytes.data(), signature, sizeof(signature))) throw Failure("capture_failed", "WIC did not encode PNG");
  size_t offset = sizeof(signature);
  while (offset + 12 <= bytes.size()) {
    uint32_t length = (uint32_t(bytes[offset]) << 24) | (uint32_t(bytes[offset + 1]) << 16) |
                      (uint32_t(bytes[offset + 2]) << 8) | uint32_t(bytes[offset + 3]);
    if (length > bytes.size() - offset - 12) throw Failure("capture_failed", "PNG exceeded fixed output buffer");
    bool end = length == 0 && std::memcmp(bytes.data() + offset + 4, "IEND", 4) == 0;
    offset += 12 + length;
    if (end) return DWORD(offset);
  }
  throw Failure("capture_failed", "PNG has no bounded end marker");
}

static DWORD encode(IWICImagingFactory* imaging, UINT width, UINT height, UINT stride, BYTE* pixels,
                    std::vector<unsigned char>& image) {
  if (!height || stride > UINT32_MAX / height) throw Failure("unsupported_surface", "source pixels exceed WIC bounds");
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  require(imaging->CreateStream(stream.GetAddressOf()), "CreateStream");
  require(stream->InitializeFromMemory(image.data(), DWORD(image.size())), "InitializeFromMemory");
  require(imaging->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.GetAddressOf()), "CreateEncoder");
  require(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), "encoder Initialize");
  require(encoder->CreateNewFrame(frame.GetAddressOf(), nullptr), "CreateNewFrame");
  require(frame->Initialize(nullptr), "frame Initialize");
  require(frame->SetSize(width, height), "frame SetSize");
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  require(frame->SetPixelFormat(&format), "frame SetPixelFormat");
  if (!IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) throw Failure("capture_failed", "WIC changed pixel format");
  require(frame->WritePixels(height, stride, stride * height, pixels), "WritePixels");
  require(frame->Commit(), "frame Commit");
  require(encoder->Commit(), "encoder Commit");
  return pngsize(image);
}

struct Pointer {
  DXGI_OUTDUPL_POINTER_SHAPE_INFO shape{};
  std::vector<BYTE> pixels;
  POINT position{};
  bool visible = false;
};

static void validate(const Pointer& pointer) {
  const auto& shape = pointer.shape;
  if (!shape.Width || !shape.Height || shape.Width > kPointerEdge || shape.Height > 2 * kPointerEdge ||
      !shape.Pitch || shape.Pitch > kPointerBytes)
    throw Failure("unsupported_surface", "pointer dimensions exceed bounds");
  uint64_t minimum = 0;
  switch (shape.Type) {
    case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR:
    case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR:
      if (shape.Height > kPointerEdge || shape.Pitch < uint64_t(shape.Width) * 4)
        throw Failure("unsupported_surface", "pointer color pitch is invalid");
      minimum = uint64_t(shape.Pitch) * shape.Height;
      break;
    case DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME:
      if (shape.Height % 2 || shape.Pitch < (uint64_t(shape.Width) + 7) / 8)
        throw Failure("unsupported_surface", "pointer mask dimensions are invalid");
      minimum = uint64_t(shape.Pitch) * shape.Height;
      break;
    default:
      throw Failure("unsupported_surface", "pointer shape type is unsupported");
  }
  if (minimum > kPointerBytes || pointer.pixels.size() < minimum || pointer.pixels.size() > kPointerBytes)
    throw Failure("unsupported_surface", "pointer shape buffer is invalid");
}

static void compose(BYTE* pixels, UINT width, UINT height, UINT stride, const Pointer& pointer, LONG left, LONG top) {
  if (!pointer.visible) return; // DXGI already included the pointer in the desktop surface.
  validate(pointer);
  if (!pixels || !width || !height || width > kEdge || height > kEdge || stride < uint64_t(width) * 4)
    throw Failure("unsupported_surface", "pointer target bounds are invalid");
  const auto& shape = pointer.shape;
  const auto count = shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME ? shape.Height / 2 : shape.Height;
  const int64_t x = int64_t(pointer.position.x) - left;
  const int64_t y = int64_t(pointer.position.y) - top;
  const int64_t x0 = std::max<int64_t>(0, x);
  const int64_t y0 = std::max<int64_t>(0, y);
  const int64_t x1 = std::min<int64_t>(width, x + shape.Width);
  const int64_t y1 = std::min<int64_t>(height, y + count);
  for (int64_t row = y0; row < y1; ++row) {
    const auto sy = size_t(row - y);
    for (int64_t col = x0; col < x1; ++col) {
      const auto sx = size_t(col - x);
      BYTE* dst = pixels + size_t(row) * stride + size_t(col) * 4;
      if (shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
        const auto offset = sy * shape.Pitch + sx / 8;
        const BYTE bit = BYTE(0x80 >> (sx % 8));
        const bool mask = (pointer.pixels[offset] & bit) != 0;
        const bool xorbit = (pointer.pixels[offset + size_t(count) * shape.Pitch] & bit) != 0;
        for (int channel = 0; channel < 3; ++channel) dst[channel] = BYTE((dst[channel] & (mask ? 0xFF : 0)) ^ (xorbit ? 0xFF : 0));
      } else {
        const BYTE* src = pointer.pixels.data() + sy * shape.Pitch + sx * 4;
        if (shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) {
          if (src[3] != 0 && src[3] != 255)
            throw Failure("unsupported_surface", "masked pointer alpha is invalid");
          for (int channel = 0; channel < 3; ++channel) dst[channel] = src[3] ? BYTE(dst[channel] ^ src[channel]) : src[channel];
        } else {
          for (int channel = 0; channel < 3; ++channel)
            dst[channel] = BYTE((unsigned(src[channel]) * src[3] + unsigned(dst[channel]) * (255 - src[3]) + 127) / 255);
        }
      }
      dst[3] = 255;
    }
  }
}

static void pointertest() {
  auto check = [](bool value, const char* detail) {
    if (!value) throw Failure("capture_failed", detail);
  };
  Pointer pointer;
  BYTE surface[16]{10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255};
  pointer.visible = true;
  pointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  pointer.shape.Width = 1;
  pointer.shape.Height = 1;
  pointer.shape.Pitch = 4;
  pointer.pixels = {110, 120, 130, 128};
  pointer.position = POINT{1, 0};
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[4] == 75 && surface[5] == 85 && surface[6] == 95, "color alpha pointer self-test failed");
  pointer.visible = false;
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[4] == 75, "hidden pointer changed desktop pixels");
  pointer.visible = true;
  pointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
  pointer.pixels = {1, 2, 3, 255};
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[4] == BYTE(75 ^ 1) && surface[5] == BYTE(85 ^ 2), "masked XOR pointer self-test failed");
  pointer.pixels = {5, 6, 7, 0};
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[4] == 5 && surface[5] == 6 && surface[6] == 7, "masked replacement pointer self-test failed");
  pointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  pointer.shape.Height = 2;
  pointer.shape.Pitch = 1;
  pointer.position = POINT{0, 0};
  pointer.pixels = {0x80, 0}; // AND=1, XOR=0: preserve the first pixel.
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[0] == 10 && surface[1] == 20, "monochrome preserve pointer self-test failed");
  pointer.pixels = {0x80, 0x80}; // AND=1, XOR=1: invert the first pixel.
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[0] == BYTE(10 ^ 255) && surface[1] == BYTE(20 ^ 255), "monochrome XOR pointer self-test failed");
  pointer.position = POINT{-1, 0}; // One-pixel shape is entirely clipped.
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[0] == BYTE(10 ^ 255), "clipped pointer changed pixels");
  pointer.shape.Width = 2;
  pointer.pixels = {0xC0, 0x40}; // Partial left clip leaves the second shape pixel visible.
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[0] == 10 && surface[1] == 20, "negative-edge pointer clipping self-test failed");
  pointer.position = POINT{1, 1};
  compose(surface, 2, 2, 8, pointer, 0, 0);
  check(surface[12] == 100, "right-edge pointer clipping self-test failed");
  pointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  pointer.shape.Width = 1;
  pointer.shape.Height = 1;
  pointer.shape.Pitch = 4;
  pointer.pixels = {255, 0, 0, 255};
  pointer.position = POINT{1, 0};
  compose(surface, 2, 2, 8, pointer, 1, 0); // Window crop starts after the pointer position.
  check(surface[0] == 255 && surface[1] == 0, "cropped pointer position self-test failed");
  pointer.shape.Pitch = 3;
  bool refused = false;
  try { compose(surface, 2, 2, 8, pointer, 0, 0); }
  catch (const Failure& error) { refused = error.code == "unsupported_surface"; }
  check(refused, "malformed color pointer was not refused");
  pointer.shape.Pitch = 4;
  pointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  pointer.shape.Height = 3;
  refused = false;
  try { compose(surface, 2, 2, 8, pointer, 0, 0); }
  catch (const Failure& error) { refused = error.code == "unsupported_surface"; }
  check(refused, "malformed monochrome pointer was not refused");
  pointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
  pointer.shape.Height = 1;
  pointer.pixels = {0, 0, 0, 128};
  refused = false;
  try { compose(surface, 2, 2, 8, pointer, 0, 0); }
  catch (const Failure& error) { refused = error.code == "unsupported_surface"; }
  check(refused, "malformed masked pointer was not refused");
}

struct Target {
  HWND handle;
  RECT rect;
  RECT desktop;
  UINT dpi;
  std::string id;
  std::string location;
};

static bool equal(RECT first, RECT second) {
  return first.left == second.left && first.top == second.top &&
         first.right == second.right && first.bottom == second.bottom;
}

static RECT intersect(RECT rect, RECT desktop) {
  RECT visible{std::max(rect.left, desktop.left), std::max(rect.top, desktop.top),
               std::min(rect.right, desktop.right), std::min(rect.bottom, desktop.bottom)};
  if (visible.right <= visible.left || visible.bottom <= visible.top)
    throw Failure("unsupported_surface", "foreground window has no observable area");
  return visible;
}

static bool overlap(RECT first, RECT second, RECT& result) {
  result = RECT{std::max(first.left, second.left), std::max(first.top, second.top),
                std::min(first.right, second.right), std::min(first.bottom, second.bottom)};
  return result.right > result.left && result.bottom > result.top;
}

static void coverage(RECT rect, const std::vector<RECT>& tiles) {
  for (size_t i = 0; i < tiles.size(); ++i)
    for (size_t j = i + 1; j < tiles.size(); ++j) {
      RECT shared{};
      if (overlap(tiles[i], tiles[j], shared))
        throw Failure("unsupported_surface", "DXGI outputs overlap in the foreground capture");
    }
  std::vector<LONG> cuts{rect.top, rect.bottom};
  for (auto tile : tiles) {
    cuts.push_back(tile.top);
    cuts.push_back(tile.bottom);
  }
  std::sort(cuts.begin(), cuts.end());
  cuts.erase(std::unique(cuts.begin(), cuts.end()), cuts.end());
  for (size_t row = 1; row < cuts.size(); ++row) {
    if (cuts[row] <= rect.top || cuts[row - 1] >= rect.bottom) continue;
    LONG edge = rect.left;
    std::vector<RECT> spans;
    for (auto tile : tiles)
      if (tile.top <= cuts[row - 1] && tile.bottom >= cuts[row]) spans.push_back(tile);
    std::sort(spans.begin(), spans.end(), [](RECT a, RECT b) { return a.left < b.left; });
    for (auto span : spans) {
      if (span.left > edge) break;
      edge = std::max(edge, span.right);
      if (edge >= rect.right) break;
    }
    if (edge < rect.right) throw Failure("unsupported_surface", "foreground window crosses an uncaptured display gap");
  }
}

static void blit(BYTE* surface, UINT width, UINT height, RECT rect, RECT tile, const BYTE* pixels, UINT stride) {
  if (tile.right <= tile.left || tile.bottom <= tile.top)
    throw Failure("unsupported_surface", "capture tile has no area");
  const auto span = UINT(tile.right - tile.left);
  const auto rows = UINT(tile.bottom - tile.top);
  if (!surface || !pixels || !span || !rows || width > kEdge || height > kEdge ||
      tile.left < rect.left || tile.top < rect.top || tile.right > rect.right || tile.bottom > rect.bottom ||
      stride < uint64_t(span) * 4 || UINT(rect.right - rect.left) != width || UINT(rect.bottom - rect.top) != height)
    throw Failure("unsupported_surface", "capture tile cannot be placed in the target");
  const auto x = size_t(tile.left - rect.left);
  const auto y = size_t(tile.top - rect.top);
  for (UINT row = 0; row < rows; ++row)
    std::memcpy(surface + ((y + row) * width + x) * 4,
                pixels + size_t(row) * stride, size_t(span) * 4);
}

static Target target() {
  HWND handle = GetForegroundWindow();
  if (!handle || !IsWindowVisible(handle)) throw Failure("no_foreground_window", "no visible foreground window");
  RECT rect{};
  if (!GetWindowRect(handle, &rect)) throw std::runtime_error("foreground window bounds unavailable");
  int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int desktopWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int desktopHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (desktopWidth <= 1 || desktopHeight <= 1)
    throw Failure("unsupported_surface", "virtual desktop bounds are unavailable");
  RECT desktop{left, top, left + desktopWidth, top + desktopHeight};
  rect = intersect(rect, desktop);
  auto width = rect.right - rect.left;
  auto height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0 || width > kEdge || height > kEdge || uint64_t(width) * height > kPixels)
    throw Failure("unsupported_surface", "foreground window exceeds capture bounds");
  UINT dpi = GetDpiForWindow(handle);
  if (!dpi) throw Failure("unsupported_surface", "foreground DPI is unavailable");
  DWORD pid = 0;
  GetWindowThreadProcessId(handle, &pid);
  if (!pid) throw std::runtime_error("foreground process unavailable");
  wchar_t title[2048]{};
  int count = GetWindowTextW(handle, title, 2048);
  if (count < 0) throw std::runtime_error("foreground title unavailable");
  std::ostringstream id;
  id << "0x" << std::uppercase << std::hex << reinterpret_cast<uintptr_t>(handle);
  std::ostringstream location;
  location << "pid:" << pid << ";title:" << utf8(std::wstring(title, size_t(count))) << ";bounds:"
           << rect.left << ',' << rect.top << ',' << width << ',' << height;
  return {handle, rect, desktop, dpi, id.str(), location.str()};
}

static void same(const Target& original) {
  auto current = target();
  if (current.handle != original.handle || current.location != original.location ||
      !equal(current.desktop, original.desktop) || current.dpi != original.dpi)
    throw Failure("target_changed", "foreground target changed during capture");
}

struct Lease {
  IDXGIOutputDuplication* duplicate;
  explicit Lease(IDXGIOutputDuplication* value) : duplicate(value) {}
  ~Lease() { if (duplicate) duplicate->ReleaseFrame(); }
  Lease(const Lease&) = delete;
  Lease& operator=(const Lease&) = delete;
};

struct Output {
  DXGI_OUTPUT_DESC desc{};
  DXGI_OUTDUPL_DESC mode{};
  RECT tile{};
  D3D11_BOX box{};
  ComPtr<IDXGIOutput1> output;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGIOutputDuplication> duplicate;
  ComPtr<ID3D11Texture2D> staging;
  bool ready = false;
};

static bool admit(bool next, bool owns, LONGLONG last, LONGLONG stamp) {
  if (!next && !owns) return false;
  if (next && !owns && last > stamp) return false;
  return true;
}

static void stable(const Output& item) {
  DXGI_OUTPUT_DESC active{};
  require(item.output->GetDesc(&active), "active output GetDesc");
  if (!active.AttachedToDesktop || active.Monitor != item.desc.Monitor ||
      !equal(active.DesktopCoordinates, item.desc.DesktopCoordinates) || active.Rotation != item.desc.Rotation)
    throw Failure("display_changed", "DXGI output geometry changed");
}

static BOOL WINAPI control(DWORD signal) {
  if (signal != CTRL_C_EVENT && signal != CTRL_BREAK_EVENT && signal != CTRL_CLOSE_EVENT) return FALSE;
  InterlockedExchange(&stopped, 1);
  return TRUE;
}

static void run(HANDLE pipe) {
  auto original = target();
  ComPtr<IDXGIFactory1> factory;
  require(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.GetAddressOf())), "CreateDXGIFactory1");
  std::vector<std::unique_ptr<Output>> outputs;
  std::vector<RECT> tiles;
  uint64_t pixels = 0;
  for (UINT a = 0;; ++a) {
    ComPtr<IDXGIAdapter1> adapter;
    HRESULT status = factory->EnumAdapters1(a, adapter.GetAddressOf());
    if (status == DXGI_ERROR_NOT_FOUND) break;
    require(status, "EnumAdapters1");
    for (UINT o = 0;; ++o) {
      ComPtr<IDXGIOutput> next;
      status = adapter->EnumOutputs(o, next.GetAddressOf());
      if (status == DXGI_ERROR_NOT_FOUND) break;
      require(status, "EnumOutputs");
      DXGI_OUTPUT_DESC desc{};
      require(next->GetDesc(&desc), "GetDesc");
      RECT tile{};
      if (!desc.AttachedToDesktop || !overlap(original.rect, desc.DesktopCoordinates, tile)) continue;
      if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY)
        throw Failure("unsupported_surface", "rotated DXGI output is not yet supported");
      if (outputs.size() >= kOutputs)
        throw Failure("unsupported_surface", "foreground window intersects too many outputs");
      auto item = std::make_unique<Output>();
      item->desc = desc;
      item->tile = tile;
      require(next.As(&item->output), "IDXGIOutput1");
      require(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                nullptr, 0, D3D11_SDK_VERSION, item->device.GetAddressOf(), nullptr,
                                item->context.GetAddressOf()), "D3D11CreateDevice");
      require(item->output->DuplicateOutput(item->device.Get(), item->duplicate.GetAddressOf()), "DuplicateOutput");
      item->duplicate->GetDesc(&item->mode);
      const auto screen = desc.DesktopCoordinates;
      if (item->mode.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
          item->mode.ModeDesc.Width != UINT(screen.right - screen.left) ||
          item->mode.ModeDesc.Height != UINT(screen.bottom - screen.top) ||
          uint64_t(item->mode.ModeDesc.Width) * item->mode.ModeDesc.Height > 16'588'800)
        throw Failure("unsupported_surface", "DXGI output format or dimensions are unsupported");
      pixels += uint64_t(item->mode.ModeDesc.Width) * item->mode.ModeDesc.Height;
      if (pixels > 66'355'200)
        throw Failure("unsupported_surface", "combined DXGI output dimensions exceed bounds");
      item->box = D3D11_BOX{UINT(tile.left - screen.left), UINT(tile.top - screen.top), 0,
                            UINT(tile.right - screen.left), UINT(tile.bottom - screen.top), 1};
      D3D11_TEXTURE2D_DESC texture{};
      texture.Width = UINT(tile.right - tile.left);
      texture.Height = UINT(tile.bottom - tile.top);
      texture.MipLevels = 1;
      texture.ArraySize = 1;
      texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      texture.SampleDesc.Count = 1;
      texture.Usage = D3D11_USAGE_STAGING;
      texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      require(item->device->CreateTexture2D(&texture, nullptr, item->staging.GetAddressOf()), "CreateTexture2D");
      tiles.push_back(tile);
      outputs.push_back(std::move(item));
    }
  }
  if (outputs.empty()) throw Failure("unsupported_surface", "foreground window has no DXGI output");
  coverage(original.rect, tiles);
  auto width = UINT(original.rect.right - original.rect.left);
  auto height = UINT(original.rect.bottom - original.rect.top);
  ComPtr<IWICImagingFactory> imaging;
  require(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(imaging.GetAddressOf())), "WIC factory");
  std::vector<unsigned char> image(kImageBytes);
  std::vector<BYTE> surface(size_t(width) * height * 4);
  Pointer pointer;
  Output* owner = nullptr;
  LONGLONG stamp = 0;
  uint64_t sequence = 0;
  uint64_t base = 0;
  auto emitted = Clock::now();
  while (!InterlockedCompareExchange(&stopped, 0, 0)) {
    same(original);
    auto begin = Clock::now();
    bool changed = false;
    for (auto& item : outputs) {
      if (InterlockedCompareExchange(&stopped, 0, 0)) break;
      stable(*item);
      DXGI_OUTDUPL_FRAME_INFO info{};
      ComPtr<IDXGIResource> resource;
      HRESULT status = item->duplicate->AcquireNextFrame(outputs.size() == 1 ? 50 : 8, &info, resource.GetAddressOf());
      if (status == DXGI_ERROR_WAIT_TIMEOUT) continue;
      require(status, "AcquireNextFrame");
      Lease lease(item->duplicate.Get());
      same(original);
      stable(*item);
      if (info.LastMouseUpdateTime.QuadPart) {
        const bool next = info.PointerPosition.Visible != 0;
        if (admit(next, owner == item.get(), stamp, info.LastMouseUpdateTime.QuadPart)) {
          pointer.position = info.PointerPosition.Position;
          pointer.visible = next;
          owner = item.get();
          stamp = info.LastMouseUpdateTime.QuadPart;
        }
      }
      if (info.PointerShapeBufferSize) {
        if (info.PointerShapeBufferSize > kPointerBytes)
          throw Failure("unsupported_surface", "pointer shape exceeds fixed buffer");
        pointer.pixels.resize(info.PointerShapeBufferSize);
        UINT required = 0;
        require(item->duplicate->GetFramePointerShape(info.PointerShapeBufferSize, pointer.pixels.data(),
                                                       &required, &pointer.shape), "GetFramePointerShape");
        if (!required || required > info.PointerShapeBufferSize)
          throw Failure("capture_failed", "pointer shape size changed during capture");
        pointer.pixels.resize(required);
        validate(pointer);
      }
      if (pointer.visible && pointer.pixels.empty())
        throw Failure("unsupported_surface", "visible pointer has no captured shape");
      ComPtr<ID3D11Texture2D> source;
      require(resource.As(&source), "capture texture");
      D3D11_TEXTURE2D_DESC current{};
      source->GetDesc(&current);
      if (current.Format != DXGI_FORMAT_B8G8R8A8_UNORM || current.Width != item->mode.ModeDesc.Width ||
          current.Height != item->mode.ModeDesc.Height || item->box.right > current.Width ||
          item->box.bottom > current.Height)
        throw Failure("display_changed", "DXGI source dimensions changed before copy");
      item->context->CopySubresourceRegion(item->staging.Get(), 0, 0, 0, 0, source.Get(), 0, &item->box);
      item->ready = true;
      changed = true;
    }
    auto acquired = Clock::now();
    same(original);
    if (InterlockedCompareExchange(&stopped, 0, 0)) break;
    if (!std::all_of(outputs.begin(), outputs.end(), [](const auto& item) { return item->ready; })) continue;
    if (!changed && base) {
      if (Clock::now() - emitted < std::chrono::milliseconds(50)) continue;
      std::ostringstream header;
      header << "{\"v\":1,\"type\":\"unchanged\",\"sequence\":" << ++sequence
             << ",\"base\":" << base
             << ",\"windowID\":" << quoted(original.id)
             << ",\"location\":" << quoted(original.location)
             << ",\"width\":" << width << ",\"height\":" << height << '}';
      packet(pipe, header.str(), nullptr, 0);
      emitted = Clock::now();
      continue;
    }
    DWORD size = 0;
    if (outputs.size() == 1 && !pointer.visible) {
      const auto& item = outputs.front();
      stable(*item);
      D3D11_MAPPED_SUBRESOURCE mapped{};
      require(item->context->Map(item->staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map");
      try {
        if (!mapped.pData || mapped.RowPitch < uint64_t(width) * 4)
          throw Failure("unsupported_surface", "mapped capture pitch is invalid");
        size = encode(imaging.Get(), width, height, mapped.RowPitch, static_cast<BYTE*>(mapped.pData), image);
      } catch (...) {
        item->context->Unmap(item->staging.Get(), 0);
        throw;
      }
      item->context->Unmap(item->staging.Get(), 0);
    } else {
      for (auto& item : outputs) {
        stable(*item);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        require(item->context->Map(item->staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map");
        try {
          const auto span = UINT(item->tile.right - item->tile.left);
          if (mapped.RowPitch < uint64_t(span) * 4 || !mapped.pData)
            throw Failure("unsupported_surface", "mapped capture pitch is invalid");
          blit(surface.data(), width, height, original.rect, item->tile,
               static_cast<BYTE*>(mapped.pData), mapped.RowPitch);
        } catch (...) {
          item->context->Unmap(item->staging.Get(), 0);
          throw;
        }
        item->context->Unmap(item->staging.Get(), 0);
      }
      if (owner && pointer.visible)
        // PointerPosition is relative to its output. HotSpot is not subtracted.
        compose(surface.data(), width, height, width * 4, pointer,
                original.rect.left - owner->desc.DesktopCoordinates.left,
                original.rect.top - owner->desc.DesktopCoordinates.top);
      size = encode(imaging.Get(), width, height, width * 4, surface.data(), image);
    }
    auto prepared = Clock::now();
    same(original);
    for (const auto& item : outputs) stable(*item);
    if (InterlockedCompareExchange(&stopped, 0, 0)) break;
    std::ostringstream header;
    base = ++sequence;
    header << std::fixed << std::setprecision(3)
           << "{\"v\":1,\"type\":\"frame\",\"sequence\":" << base
           << ",\"windowID\":" << quoted(original.id)
           << ",\"location\":" << quoted(original.location)
           << ",\"width\":" << width << ",\"height\":" << height
           << ",\"mime\":\"image/png\",\"acquisitionMs\":" << ms(begin, acquired)
           << ",\"preparationMs\":" << ms(acquired, prepared) << '}';
    packet(pipe, header.str(), image.data(), size);
    emitted = Clock::now();
  }
}

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  SetUnhandledExceptionFilter(fault);
  SetConsoleCtrlHandler(control, TRUE);
  HANDLE pipe = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!pipe || pipe == INVALID_HANDLE_VALUE) return 2;
  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    terminal(pipe, "dpi_unavailable");
    return 1;
  }
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initialized)) {
    terminal(pipe, "com_init_failed");
    return 1;
  }
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--fault-test") {
      RaiseException(EXCEPTION_ACCESS_VIOLATION, 0, 0, nullptr);
      return 3;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
      {
        pointertest();
        RECT visible = intersect(RECT{-8, -8, 1928, 1088}, RECT{0, 0, 1920, 1080});
        if (visible.left != 0 || visible.top != 0 || visible.right != 1920 || visible.bottom != 1080)
          throw Failure("capture_failed", "visible desktop clipping self-test failed");
        if (equal(RECT{0, 0, 1920, 1080}, RECT{0, 0, 1920, 1079}))
          throw Failure("capture_failed", "display geometry change self-test failed");
        bool refused = false;
        try {
          intersect(RECT{-100, -100, -1, -1}, RECT{0, 0, 1920, 1080});
        } catch (const Failure& error) {
          refused = error.code == "unsupported_surface";
        }
        if (!refused) throw Failure("capture_failed", "disjoint window clipping self-test failed");
        RECT window{-2, -1, 2, 1};
        RECT left{};
        RECT right{};
        if (!overlap(window, RECT{-1920, -1080, 0, 1080}, left) ||
            !overlap(window, RECT{0, -1080, 1920, 1080}, right) ||
            !equal(left, RECT{-2, -1, 0, 1}) || !equal(right, RECT{0, -1, 2, 1}))
          throw Failure("capture_failed", "negative-origin output clipping self-test failed");
        coverage(window, {left, right});
        BYTE leftPixels[16]{1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255};
        BYTE rightPixels[16]{5, 0, 0, 255, 6, 0, 0, 255, 7, 0, 0, 255, 8, 0, 0, 255};
        BYTE joined[32]{};
        blit(joined, 4, 2, window, left, leftPixels, 8);
        blit(joined, 4, 2, window, right, rightPixels, 8);
        if (joined[0] != 1 || joined[4] != 2 || joined[8] != 5 || joined[12] != 6 ||
            joined[16] != 3 || joined[20] != 4 || joined[24] != 7 || joined[28] != 8)
          throw Failure("capture_failed", "negative-origin tile composition self-test failed");
        refused = false;
        try { coverage(window, {left, RECT{1, -1, 2, 1}}); }
        catch (const Failure& error) { refused = error.code == "unsupported_surface"; }
        if (!refused) throw Failure("capture_failed", "display gap was not refused");
        refused = false;
        try { coverage(window, {left, RECT{-1, -1, 2, 1}}); }
        catch (const Failure& error) { refused = error.code == "unsupported_surface"; }
        if (!refused) throw Failure("capture_failed", "overlapping outputs were not refused");
        refused = false;
        try { blit(joined, 4, 2, window, RECT{-3, -1, 0, 1}, leftPixels, 12); }
        catch (const Failure& error) { refused = error.code == "unsupported_surface"; }
        if (!refused) throw Failure("capture_failed", "out-of-window tile was not refused");
        if (admit(false, false, 10, 11) || admit(true, false, 10, 9) ||
            !admit(true, false, 10, 11) || !admit(false, true, 10, 11))
          throw Failure("capture_failed", "cross-output pointer handoff self-test failed");
        ComPtr<IWICImagingFactory> imaging;
        require(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_PPV_ARGS(imaging.GetAddressOf())), "WIC factory");
        BYTE pixels[16]{0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255};
        std::vector<unsigned char> image(kImageBytes);
        if (encode(imaging.Get(), 2, 2, 8, pixels, image) < 30) throw Failure("capture_failed", "self-test PNG is too short");
      }
      CoUninitialize();
      return 0;
    }
    if (argc != 1) throw Failure("invalid_argument", "unsupported capture argument");
    run(pipe);
    CoUninitialize();
    return 0;
  } catch (const Failure& error) {
    terminal(pipe, error.code);
    CoUninitialize();
    return 1;
  } catch (const std::exception& error) {
    // Pipe closure is cancellation. A live consumer receives one terminal error packet.
    if (std::string(error.what()) != "stdout pipe closed") {
      terminal(pipe, "capture_failed");
    }
    CoUninitialize();
    return 1;
  }
}
