// Experimental native capture host, launched only by the explicit Windows candidate switch.
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <iomanip>
#include <memory>
#include <optional>
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
static constexpr UINT kMetadataBytes = 1'024 * 1'024;
static constexpr UINT kOutputs = 8;
static constexpr DWORD kBarrierBytes = 148;
static constexpr auto kBarrierTimeout = std::chrono::milliseconds(750);
static volatile LONG stopped = 0;
static volatile LONG faulting = 0;
static HANDLE receipt = INVALID_HANDLE_VALUE;
static wchar_t receiptPath[MAX_PATH]{};
static uintptr_t imageBase = 0;
static uintptr_t imageLimit = 0;
static std::atomic<uint64_t> foregroundEpoch{0};

static void CALLBACK foreground(HWINEVENTHOOK, DWORD event, HWND, LONG, LONG, DWORD, DWORD) {
  if (event == EVENT_SYSTEM_FOREGROUND) foregroundEpoch.fetch_add(1, std::memory_order_release);
}

struct ForegroundWatch {
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE thread = nullptr;
  DWORD id = 0;
  HWINEVENTHOOK hook = nullptr;

  static DWORD WINAPI listen(void* value) {
    auto& watch = *static_cast<ForegroundWatch*>(value);
    MSG msg{};
    PeekMessageW(&msg, nullptr, 0, 0, PM_NOREMOVE);
    watch.hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr,
                                 foreground, 0, 0, WINEVENT_OUTOFCONTEXT);
    SetEvent(watch.ready);
    if (!watch.hook) return 1;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    UnhookWinEvent(watch.hook);
    return 0;
  }

  ForegroundWatch() {
    if (!ready) throw std::runtime_error("foreground event gate is unavailable");
    thread = CreateThread(nullptr, 0, listen, this, 0, &id);
    if (!thread) {
      CloseHandle(ready);
      ready = nullptr;
      throw std::runtime_error("foreground event listener could not start");
    }
    const DWORD status = WaitForSingleObject(ready, 2'000);
    if (status != WAIT_OBJECT_0) ExitProcess(2);
    if (!hook) {
      PostThreadMessageW(id, WM_QUIT, 0, 0);
      WaitForSingleObject(thread, INFINITE);
      CloseHandle(thread);
      CloseHandle(ready);
      throw std::runtime_error("foreground event listener could not bind");
    }
  }

  ~ForegroundWatch() {
    PostThreadMessageW(id, WM_QUIT, 0, 0);
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
    CloseHandle(ready);
  }

  uint64_t value() const { return foregroundEpoch.load(std::memory_order_acquire); }
};

static void hex(char* text, size_t& length, uint64_t value, unsigned digits) {
  static constexpr char symbols[] = "0123456789ABCDEF";
  for (unsigned shift = digits * 4; shift; shift -= 4)
    text[length++] = symbols[(value >> (shift - 4)) & 15];
}

static void initreceipt() {
  const HMODULE module = GetModuleHandleW(nullptr);
  if (!module) throw std::runtime_error("capture module is unavailable");
  imageBase = reinterpret_cast<uintptr_t>(module);
  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(module);
  if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0)
    throw std::runtime_error("capture module header is invalid");
  const auto* image = reinterpret_cast<const IMAGE_NT_HEADERS*>(imageBase + dos->e_lfanew);
  if (image->Signature != IMAGE_NT_SIGNATURE || !image->OptionalHeader.SizeOfImage)
    throw std::runtime_error("capture image bounds are invalid");
  imageLimit = imageBase + image->OptionalHeader.SizeOfImage;
  const DWORD count = GetEnvironmentVariableW(L"RAYA_NATIVE_FAULT_RECEIPT", receiptPath, MAX_PATH);
  if (!count) return;
  if (count >= MAX_PATH) throw std::runtime_error("capture receipt path is too long");
  receipt = CreateFileW(receiptPath, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                        FILE_ATTRIBUTE_HIDDEN, nullptr);
  if (receipt == INVALID_HANDLE_VALUE) throw std::runtime_error("capture receipt could not be opened");
}

static void clearreceipt() {
  if (receipt == INVALID_HANDLE_VALUE) return;
  CloseHandle(receipt);
  receipt = INVALID_HANDLE_VALUE;
  DeleteFileW(receiptPath);
}

static LONG WINAPI fault(EXCEPTION_POINTERS* info) {
  if (InterlockedCompareExchange(&faulting, 1, 0) || !info || !info->ExceptionRecord)
    return EXCEPTION_EXECUTE_HANDLER;
  const auto address = reinterpret_cast<uintptr_t>(info->ExceptionRecord->ExceptionAddress);
  if (receipt != INVALID_HANDLE_VALUE) {
    char line[64]{};
    size_t length = 0;
    hex(line, length, info->ExceptionRecord->ExceptionCode, 8);
    line[length++] = ':';
    if (imageBase && address >= imageBase && address < imageLimit) {
      const char label[] = "main+0x";
      for (size_t index = 0; index < sizeof(label) - 1; ++index) line[length++] = label[index];
      hex(line, length, address - imageBase, 16);
    } else {
      const char label[] = "external+0x0";
      for (size_t index = 0; index < sizeof(label) - 1; ++index) line[length++] = label[index];
    }
    line[length++] = '\n';
    DWORD written = 0;
    WriteFile(receipt, line, DWORD(length), &written, nullptr);
    FlushFileBuffers(receipt);
  }
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
  if (!width || !height || uint64_t(width) * 4 != stride || stride > UINT32_MAX / height)
    throw Failure("unsupported_surface", "source pixels must be tightly packed within WIC bounds");
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
  std::string identity;
};

static std::string fingerprint(HWND window, DWORD pid);
static std::string pinned(HWND window, DWORD pid);

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

static Target target(bool bind = false) {
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
  return {handle, rect, desktop, dpi, id.str(), location.str(), bind ? pinned(handle, pid) : ""};
}

static void same(const Target& original, uint64_t epoch) {
  if (foregroundEpoch.load(std::memory_order_acquire) != epoch)
    throw Failure("target_changed", "foreground changed during capture");
  auto current = target();
  if (current.handle != original.handle || current.location != original.location ||
      !equal(current.desktop, original.desktop) || current.dpi != original.dpi)
    throw Failure("target_changed", "foreground target changed during capture");
}

static void sameidentity(const Target& original) {
  if (original.identity.empty()) return;
  DWORD pid = 0;
  if (GetForegroundWindow() != original.handle || !IsWindowVisible(original.handle) ||
      !GetWindowThreadProcessId(original.handle, &pid) ||
      fingerprint(original.handle, pid) != original.identity)
    throw Failure("target_changed", "foreground window instance changed during capture");
}

struct Barrier {
  std::string request;
  uint64_t scene = 0;
  uint64_t source = 0;
  LONGLONG receipt = 0;
  LONGLONG present = 0;
  Clock::time_point started;
  uint64_t handle = 0;
  uint32_t pid = 0;
  RECT rect{};
  std::string identity;
};

static void unproven(HANDLE pipe, const Barrier& barrier, const char* reason) {
  std::ostringstream header;
  header << "{\"v\":2,\"type\":\"barrier\",\"status\":\"unproven\",\"reason\":\"" << reason
         << "\",\"request\":" << quoted(barrier.request) << ",\"scene\":" << barrier.scene
         << ",\"source\":" << barrier.source << ",\"receiptQpc\":\"" << barrier.receipt << "\"}";
  packet(pipe, header.str(), nullptr, 0);
}

static uint32_t word(const BYTE* data) {
  return uint32_t(data[0]) | uint32_t(data[1]) << 8 | uint32_t(data[2]) << 16 | uint32_t(data[3]) << 24;
}

static uint64_t wide(const BYTE* data) {
  return uint64_t(word(data)) | uint64_t(word(data + 4)) << 32;
}

static std::string tagged(std::string source, uintptr_t instance) {
  if (instance) source += ";instance:" + std::to_string(instance);
  return source;
}

static std::string fingerprint(HWND window, DWORD pid) {
  wchar_t cls[512]{};
  if (!GetClassNameW(window, cls, 512)) return {};
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return {};
  FILETIME creation{}, exit{}, kernel{}, user{};
  const bool times = GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0;
  CloseHandle(process);
  if (!times) return {};
  const uint64_t ticks = (uint64_t(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, cls, -1, nullptr, 0, nullptr, nullptr);
  if (bytes <= 1 || bytes > 2048) return {};
  std::string name(size_t(bytes), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, cls, -1, name.data(), bytes, nullptr, nullptr)) return {};
  name.pop_back();
  const auto instance = reinterpret_cast<uintptr_t>(
    GetPropW(window, L"RayaDesktopWindowInstanceV1_74CB301759F7435B9AD54D283319FF5B"));
  const std::string source = tagged("pid:" + std::to_string(pid) + ";start:" +
    std::to_string(ticks + 504911232000000000ULL) + ";class:" + name, instance);
  HCRYPTPROV provider = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return {};
  HCRYPTHASH hash = 0;
  const bool created = CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) != 0;
  std::array<BYTE, 32> digest{};
  DWORD size = DWORD(digest.size());
  const bool hashed = created && CryptHashData(hash, reinterpret_cast<const BYTE*>(source.data()), DWORD(source.size()), 0) &&
    CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &size, 0);
  if (created) CryptDestroyHash(hash);
  CryptReleaseContext(provider, 0);
  if (!hashed || size != digest.size()) return {};
  static constexpr char digits[] = "0123456789ABCDEF";
  std::string value;
  value.reserve(64);
  for (BYTE byte : digest) {
    value.push_back(digits[byte >> 4]);
    value.push_back(digits[byte & 15]);
  }
  return value;
}

static std::string pinned(HWND window, DWORD pid) {
  static constexpr wchar_t property[] = L"RayaDesktopWindowInstanceV1_74CB301759F7435B9AD54D283319FF5B";
  if (!GetPropW(window, property)) {
    HCRYPTPROV provider = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return {};
    uintptr_t token = 0;
    const bool random = CryptGenRandom(provider, DWORD(sizeof(token)), reinterpret_cast<BYTE*>(&token)) != 0;
    CryptReleaseContext(provider, 0);
    if (!random) return {};
    token &= UINTPTR_MAX >> 1;
    if (!token) token = 1;
    if (!SetPropW(window, property, reinterpret_cast<HANDLE>(token)) ||
        GetPropW(window, property) != reinterpret_cast<HANDLE>(token)) return {};
  }
  if (GetForegroundWindow() != window || !IsWindowVisible(window)) return {};
  return fingerprint(window, pid);
}

static bool exact(const Target& original, uint64_t handle, uint32_t pid, const RECT& rect,
                  const std::string& identity) {
  if (original.identity.empty() || original.identity != identity ||
      handle != reinterpret_cast<uintptr_t>(original.handle) || !equal(rect, original.rect)) return false;
  const HWND window = original.handle;
  if (GetForegroundWindow() != window || !IsWindowVisible(window)) return false;
  DWORD current = 0;
  if (!GetWindowThreadProcessId(window, &current) || current != pid) return false;
  return fingerprint(window, pid) == identity;
}

static std::optional<Barrier> receive(HANDLE input, const Target& original, uint64_t base, uint64_t& last,
                                      HANDLE pipe, bool multi) {
  DWORD available = 0;
  if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
    if (GetLastError() == ERROR_BROKEN_PIPE) return std::nullopt;
    throw Failure("capture_failed", "capture control pipe unavailable");
  }
  if (available < kBarrierBytes) return std::nullopt;
  BYTE data[kBarrierBytes]{};
  DWORD received = 0;
  if (!ReadFile(input, data, kBarrierBytes, &received, nullptr) || received != kBarrierBytes)
    throw Failure("capture_failed", "capture barrier command incomplete");
  if (std::memcmp(data, "RCB2", 4) || word(data + 4) != kBarrierBytes)
    throw Failure("invalid_argument", "capture barrier version or length invalid");
  const uint64_t scene = wide(data + 8);
  const uint64_t source = wide(data + 16);
  const uint64_t handle = wide(data + 24);
  const uint32_t pid = word(data + 32);
  const RECT rect{LONG(word(data + 36)), LONG(word(data + 40)), LONG(word(data + 44)), LONG(word(data + 48))};
  const std::string request(reinterpret_cast<const char*>(data + 52), 32);
  const std::string identity(reinterpret_cast<const char*>(data + 84), 64);
  if (!scene || !source || !std::all_of(request.begin(), request.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
      }) || !std::all_of(identity.begin(), identity.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
      })) throw Failure("invalid_argument", "capture barrier identity invalid");
  LARGE_INTEGER tick{};
  if (!QueryPerformanceCounter(&tick)) throw Failure("capture_failed", "QPC unavailable");
  Barrier barrier{request, scene, source, tick.QuadPart, 0, Clock::now(), handle, pid, rect, identity};
  if (scene <= last) {
    unproven(pipe, barrier, "stale_scene");
    return std::nullopt;
  }
  last = scene;
  const bool matching = exact(original, handle, pid, rect, identity);
  if (source != base) {
    unproven(pipe, barrier, "source_changed");
    return std::nullopt;
  }
  if (matching && !multi) return barrier;
  unproven(pipe, barrier, matching ? "multiple_outputs" : "target_changed");
  return std::nullopt;
}

static void samebarrier(const Target& original, const std::optional<Barrier>& barrier, HANDLE pipe,
                        uint64_t epoch) {
  try {
    same(original, epoch);
    if (barrier && !exact(original, barrier->handle, barrier->pid, barrier->rect, barrier->identity))
      throw Failure("target_changed", "post-action target identity changed");
  }
  catch (const Failure& error) {
    if (barrier && error.code == "target_changed") unproven(pipe, *barrier, "target_changed");
    throw;
  }
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
  std::vector<BYTE> metadata;
  bool ready = false;
};

static bool intersects(RECT rect, const Output& item) {
  if (rect.left < 0 || rect.top < 0 || rect.right > LONG(item.mode.ModeDesc.Width) ||
      rect.bottom > LONG(item.mode.ModeDesc.Height) || rect.left >= rect.right || rect.top >= rect.bottom)
    return true;
  return int64_t(rect.left) < item.box.right && int64_t(rect.top) < item.box.bottom &&
         int64_t(rect.right) > item.box.left && int64_t(rect.bottom) > item.box.top;
}

static bool intersects(const DXGI_OUTDUPL_MOVE_RECT& move, const Output& item) {
  const RECT dest = move.DestinationRect;
  if (intersects(dest, item)) return true;
  const int64_t right = int64_t(move.SourcePoint.x) + dest.right - dest.left;
  const int64_t bottom = int64_t(move.SourcePoint.y) + dest.bottom - dest.top;
  if (move.SourcePoint.x < 0 || move.SourcePoint.y < 0 ||
      right > item.mode.ModeDesc.Width || bottom > item.mode.ModeDesc.Height ||
      right <= move.SourcePoint.x || bottom <= move.SourcePoint.y)
    return true;
  return intersects(RECT{move.SourcePoint.x, move.SourcePoint.y, LONG(right), LONG(bottom)}, item);
}

// Metadata can prove a cropped tile unchanged, but an incomplete list must never suppress a copy.
static bool affects(Output& item, const DXGI_OUTDUPL_FRAME_INFO& info) {
  const UINT size = info.TotalMetadataBufferSize;
  if (!item.ready || !size || size > kMetadataBytes ||
      !info.LastPresentTime.QuadPart || !info.AccumulatedFrames)
    return true;
  item.metadata.resize(size);
  UINT used = 0;
  HRESULT status = item.duplicate->GetFrameMoveRects(size, reinterpret_cast<DXGI_OUTDUPL_MOVE_RECT*>(item.metadata.data()), &used);
  if (status == DXGI_ERROR_ACCESS_LOST) require(status, "GetFrameMoveRects");
  if (status != S_OK || used > size || used % sizeof(DXGI_OUTDUPL_MOVE_RECT)) return true;
  for (UINT offset = 0; offset < used; offset += sizeof(DXGI_OUTDUPL_MOVE_RECT)) {
    DXGI_OUTDUPL_MOVE_RECT move{};
    std::memcpy(&move, item.metadata.data() + offset, sizeof(move));
    if (intersects(move, item)) return true;
  }
  UINT dirty = 0;
  status = item.duplicate->GetFrameDirtyRects(size - used,
    reinterpret_cast<RECT*>(item.metadata.data() + used), &dirty);
  if (status == DXGI_ERROR_ACCESS_LOST) require(status, "GetFrameDirtyRects");
  if (status != S_OK || dirty > size - used || dirty % sizeof(RECT) || used + dirty != size) return true;
  for (UINT offset = 0; offset < dirty; offset += sizeof(RECT)) {
    RECT rect{};
    std::memcpy(&rect, item.metadata.data() + used + offset, sizeof(rect));
    if (intersects(rect, item)) return true;
  }
  return false;
}

static bool touches(const Pointer& pointer, const Output* owner, RECT target) {
  if (!owner || !pointer.visible) return false;
  validate(pointer);
  const auto rows = pointer.shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
                      ? pointer.shape.Height / 2 : pointer.shape.Height;
  const int64_t x = int64_t(owner->desc.DesktopCoordinates.left) + pointer.position.x;
  const int64_t y = int64_t(owner->desc.DesktopCoordinates.top) + pointer.position.y;
  return x < target.right && y < target.bottom &&
         x + pointer.shape.Width > target.left && y + rows > target.top;
}

static bool presented(const DXGI_OUTDUPL_FRAME_INFO& info, bool ready) {
  return !ready || info.LastPresentTime.QuadPart || info.AccumulatedFrames || info.TotalMetadataBufferSize;
}

static bool later(const DXGI_OUTDUPL_FRAME_INFO& info, const std::optional<Barrier>& barrier) {
  return barrier && !barrier->present && info.LastPresentTime.QuadPart > barrier->receipt && info.AccumulatedFrames;
}

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
  DXGI_OUTDUPL_DESC mode{};
  item.duplicate->GetDesc(&mode);
  if (mode.ModeDesc.Width != item.mode.ModeDesc.Width || mode.ModeDesc.Height != item.mode.ModeDesc.Height ||
      mode.ModeDesc.Format != item.mode.ModeDesc.Format || mode.Rotation != item.mode.Rotation)
    throw Failure("display_changed", "DXGI duplication mode changed");
}

static BOOL WINAPI control(DWORD signal) {
  if (signal != CTRL_C_EVENT && signal != CTRL_BREAK_EVENT && signal != CTRL_CLOSE_EVENT) return FALSE;
  InterlockedExchange(&stopped, 1);
  return TRUE;
}

static void bound(HANDLE pipe, ForegroundWatch& watch, uint64_t& sequence, uint64_t epoch,
                  uint64_t& scene) {
  auto original = target(true);
  const auto foreground = watch.value();
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE || GetFileType(input) != FILE_TYPE_PIPE)
    throw Failure("capture_failed", "capture control pipe is unavailable");
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
  uint64_t base = 0;
  std::optional<Barrier> barrier;
  auto emitted = Clock::now();
  while (!InterlockedCompareExchange(&stopped, 0, 0)) {
    if (sequence >= 9'007'199'254'740'991ULL)
      throw Failure("capture_failed", "native frame sequence reached its protocol limit");
    if (auto next = receive(input, original, base, scene, pipe, outputs.size() != 1)) {
      if (barrier) unproven(pipe, *barrier, "superseded");
      barrier = std::move(next);
    }
    samebarrier(original, barrier, pipe, foreground);
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
      samebarrier(original, barrier, pipe, foreground);
      stable(*item);
      const bool previous = touches(pointer, owner, original.rect);
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
      const bool fresh = later(info, barrier);
      const bool desktop = fresh || (presented(info, item->ready) && affects(*item, info));
      if (desktop) {
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
        if (fresh) barrier->present = info.LastPresentTime.QuadPart;
      }
      const bool moved = info.LastMouseUpdateTime.QuadPart || info.PointerShapeBufferSize;
      changed = changed || desktop || (moved &&
        (previous || touches(pointer, owner, original.rect)));
    }
    auto acquired = Clock::now();
    samebarrier(original, barrier, pipe, foreground);
    if (InterlockedCompareExchange(&stopped, 0, 0)) break;
    if (barrier && !barrier->present) {
      if (Clock::now() - barrier->started >= kBarrierTimeout) {
        unproven(pipe, *barrier, "no_present");
        barrier.reset();
      }
      continue;
    }
    if (!std::all_of(outputs.begin(), outputs.end(), [](const auto& item) { return item->ready; })) continue;
    if (!changed && base) {
      if (Clock::now() - emitted < std::chrono::milliseconds(50)) continue;
      for (const auto& item : outputs) stable(*item);
      sameidentity(original);
      std::ostringstream header;
      header << "{\"v\":3,\"type\":\"unchanged\",\"epoch\":" << epoch
             << ",\"sequence\":" << ++sequence
             << ",\"base\":" << base
             << ",\"windowID\":" << quoted(original.id)
             << ",\"location\":" << quoted(original.location);
      if (!original.identity.empty()) header << ",\"identity\":" << quoted(original.identity);
      header
             << ",\"width\":" << width << ",\"height\":" << height << '}';
      packet(pipe, header.str(), nullptr, 0);
      emitted = Clock::now();
      continue;
    }
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
    const DWORD size = encode(imaging.Get(), width, height, width * 4, surface.data(), image);
    auto prepared = Clock::now();
    samebarrier(original, barrier, pipe, foreground);
    for (const auto& item : outputs) stable(*item);
    if (InterlockedCompareExchange(&stopped, 0, 0)) break;
    sameidentity(original);
    std::ostringstream header;
    base = ++sequence;
    header << std::fixed << std::setprecision(3)
           << "{\"v\":3,\"type\":\"frame\",\"epoch\":" << epoch
           << ",\"sequence\":" << base
           << ",\"windowID\":" << quoted(original.id)
           << ",\"location\":" << quoted(original.location);
    if (!original.identity.empty()) header << ",\"identity\":" << quoted(original.identity);
    header
           << ",\"width\":" << width << ",\"height\":" << height
           << ",\"mime\":\"image/png\",\"acquisitionMs\":" << ms(begin, acquired)
           << ",\"preparationMs\":" << ms(acquired, prepared);
    if (barrier)
      header << ",\"request\":" << quoted(barrier->request) << ",\"scene\":" << barrier->scene
             << ",\"source\":" << barrier->source << ",\"receiptQpc\":\"" << barrier->receipt
             << "\",\"presentQpc\":\"" << barrier->present << '"';
    header << '}';
    packet(pipe, header.str(), image.data(), size);
    barrier.reset();
    emitted = Clock::now();
  }
}

static void run(HANDLE pipe) {
  ForegroundWatch watch;
  uint64_t sequence = 0;
  uint64_t scene = 0;
  uint64_t epoch = 1;
  auto deadline = Clock::time_point{};
  while (!InterlockedCompareExchange(&stopped, 0, 0)) {
    const auto before = sequence;
    try {
      bound(pipe, watch, sequence, epoch, scene);
      return;
    } catch (const Failure& error) {
      if (InterlockedCompareExchange(&stopped, 0, 0)) return;
      const bool changed = error.code == "target_changed" || error.code == "display_changed" ||
                           (error.code == "no_foreground_window" && sequence > before);
      if (changed) {
        if (epoch >= 9'007'199'254'740'991ULL)
          throw Failure("capture_failed", "native target epoch reached its protocol limit");
        ++epoch;
        std::ostringstream header;
        header << "{\"v\":3,\"type\":\"reset\",\"epoch\":" << epoch
               << ",\"reason\":\"" << (error.code == "display_changed" ? "display_changed" : "target_changed")
               << "\"}";
        packet(pipe, header.str(), nullptr, 0);
        deadline = Clock::now() + std::chrono::seconds(2);
        Sleep(25);
        continue;
      }
      if (error.code == "no_foreground_window" && epoch > 1 && Clock::now() < deadline) {
        Sleep(25);
        continue;
      }
      throw;
    }
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
    initreceipt();
    if (argc == 2 && std::wstring(argv[1]) == L"--fault-test") {
      RaiseException(EXCEPTION_ACCESS_VIOLATION, 0, 0, nullptr);
      return 3;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
      {
        HWND instance = CreateWindowExW(0, L"STATIC", L"Raya instance self-test", 0,
                                       0, 0, 1, 1, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!instance) throw Failure("capture_failed", "window instance self-test could not create a window");
        ForegroundWatch watch;
        const auto epoch = watch.value();
        const HWND event = GetForegroundWindow() ? GetForegroundWindow() : instance;
        NotifyWinEvent(EVENT_SYSTEM_FOREGROUND, event, OBJID_WINDOW, CHILDID_SELF);
        for (int attempt = 0; attempt < 100 && watch.value() == epoch; ++attempt) Sleep(2);
        if (watch.value() == epoch)
          throw Failure("capture_failed", "foreground change event was not observed");
        bool stale = false;
        try { same(Target{}, epoch); }
        catch (const Failure& error) { stale = error.code == "target_changed"; }
        if (!stale) throw Failure("capture_failed", "foreground event did not invalidate the scene");
        const std::string base = "pid:7;start:123;class:Editor";
        if (tagged(base, 0) != base || tagged(base, 1) == base || tagged(base, 1) == tagged(base, 2))
          throw Failure("capture_failed", "window instance fingerprint self-test failed");
        static constexpr wchar_t property[] = L"RayaDesktopWindowInstanceV1_74CB301759F7435B9AD54D283319FF5B";
        const auto initial = fingerprint(instance, GetCurrentProcessId());
        const bool first = SetPropW(instance, property, reinterpret_cast<HANDLE>(uintptr_t(1))) != 0;
        const auto tokenized = fingerprint(instance, GetCurrentProcessId());
        const bool second = SetPropW(instance, property, reinterpret_cast<HANDLE>(uintptr_t(2))) != 0;
        const auto replaced = fingerprint(instance, GetCurrentProcessId());
        RemovePropW(instance, property);
        DestroyWindow(instance);
        if (!first || !second || initial.empty() || tokenized.empty() || replaced.empty() ||
            initial == tokenized || tokenized == replaced || initial == replaced) {
          std::fprintf(stderr, "Raya native instance self-test fingerprint failed: %d %d %zu %zu %zu\n",
                       first, second, initial.size(), tokenized.size(), replaced.size());
          throw Failure("capture_failed", "same-window instance token change was not detected");
        }
        Target bound{};
        bound.handle = GetForegroundWindow();
        DWORD pid = 0;
        if (bound.handle && GetWindowThreadProcessId(bound.handle, &pid) && pid) {
          bound.identity = fingerprint(bound.handle, pid);
          if (!bound.identity.empty()) {
            sameidentity(bound);
            bound.identity[0] = bound.identity[0] == '0' ? '1' : '0';
            bool changed = false;
            try { sameidentity(bound); }
            catch (const Failure& error) { changed = error.code == "target_changed"; }
            if (!changed)
              throw Failure("capture_failed", "changed window instance fingerprint was not refused");
          }
        }
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
        DXGI_OUTDUPL_FRAME_INFO info{};
        if (!presented(info, false) || presented(info, true))
          throw Failure("capture_failed", "initial or pointer-only frame classification failed");
        info.LastPresentTime.QuadPart = 1;
        if (!presented(info, true)) throw Failure("capture_failed", "desktop present was skipped");
        info.LastPresentTime.QuadPart = 0;
        info.TotalMetadataBufferSize = 1;
        if (!presented(info, true)) throw Failure("capture_failed", "desktop metadata was skipped");
        info.TotalMetadataBufferSize = 0;
        info.AccumulatedFrames = 1;
        if (!presented(info, true)) throw Failure("capture_failed", "accumulated desktop frame was skipped");
        const Barrier barrier{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 7, 1, 100, 0, Clock::now(), 1, 1,
                              RECT{0, 0, 100, 100}, std::string(64, 'A')};
        info.LastPresentTime.QuadPart = 99;
        if (later(info, barrier)) throw Failure("capture_failed", "pre-action desktop present was admitted");
        info.LastPresentTime.QuadPart = 100;
        if (later(info, barrier)) throw Failure("capture_failed", "same-tick desktop present was admitted");
        info.LastPresentTime.QuadPart = 101;
        if (!later(info, barrier)) throw Failure("capture_failed", "post-action desktop present was missed");
        info.AccumulatedFrames = 0;
        if (later(info, barrier)) throw Failure("capture_failed", "pointer-only desktop event was admitted");
        info.AccumulatedFrames = 1;
        auto used = barrier;
        used.present = 101;
        if (later(info, used)) throw Failure("capture_failed", "duplicate post-action present was admitted");
        BYTE command[kBarrierBytes]{};
        std::memcpy(command, "RCB2", 4);
        command[4] = BYTE(kBarrierBytes);
        command[8] = 7;
        command[16] = 1;
        if (word(command + 4) != kBarrierBytes || wide(command + 8) != 7 || wide(command + 16) != 1)
          throw Failure("capture_failed", "barrier wire header self-test failed");
        Output cropout;
        cropout.mode.ModeDesc.Width = 1920;
        cropout.mode.ModeDesc.Height = 1080;
        cropout.box = D3D11_BOX{100, 100, 0, 300, 300, 1};
        if (intersects(RECT{0, 0, 100, 100}, cropout) ||
            !intersects(RECT{99, 99, 101, 101}, cropout) ||
            !intersects(RECT{-1, 0, 10, 10}, cropout) ||
            !intersects(RECT{10, 10, 10, 20}, cropout) ||
            !intersects(RECT{1900, 100, 1930, 200}, cropout))
          throw Failure("capture_failed", "dirty-region crop classification failed");
        DXGI_OUTDUPL_MOVE_RECT move{};
        move.SourcePoint = POINT{0, 0};
        move.DestinationRect = RECT{400, 400, 450, 450};
        if (intersects(move, cropout)) throw Failure("capture_failed", "off-window move affected crop");
        move.SourcePoint = POINT{150, 150};
        if (!intersects(move, cropout)) throw Failure("capture_failed", "move source missed crop");
        move.SourcePoint = POINT{0, 0};
        move.DestinationRect = RECT{250, 250, 350, 350};
        if (!intersects(move, cropout)) throw Failure("capture_failed", "move destination missed crop");
        move.DestinationRect = RECT{400, 400, 450, 450};
        move.SourcePoint = POINT{1910, 100};
        if (!intersects(move, cropout)) throw Failure("capture_failed", "invalid move source was not copied");
        cropout.ready = true;
        DXGI_OUTDUPL_FRAME_INFO metadata{};
        metadata.LastPresentTime.QuadPart = 1;
        metadata.AccumulatedFrames = 1;
        if (!affects(cropout, metadata))
          throw Failure("capture_failed", "missing dirty metadata was not copied");
        metadata.TotalMetadataBufferSize = kMetadataBytes + 1;
        if (!affects(cropout, metadata))
          throw Failure("capture_failed", "oversized dirty metadata was not copied");
        metadata.TotalMetadataBufferSize = 1;
        metadata.AccumulatedFrames = 0;
        if (!affects(cropout, metadata))
          throw Failure("capture_failed", "contradictory dirty metadata was not copied");
        Output sample;
        sample.desc.DesktopCoordinates = RECT{-1920, 0, 0, 1080};
        Pointer cursor;
        cursor.visible = true;
        cursor.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
        cursor.shape.Width = 4;
        cursor.shape.Height = 1;
        cursor.shape.Pitch = 16;
        cursor.pixels.resize(16);
        cursor.position = POINT{1890, 0};
        RECT crop{-20, 0, 20, 20};
        if (touches(cursor, &sample, crop))
          throw Failure("capture_failed", "off-window pointer touched capture");
        cursor.position.x = 1899;
        if (!touches(cursor, &sample, crop))
          throw Failure("capture_failed", "cross-output pointer missed capture edge");
        cursor.position.x = 1940;
        if (touches(cursor, &sample, crop))
          throw Failure("capture_failed", "right-edge pointer touched capture");
        cursor.position.x = 1899;
        cursor.visible = false;
        if (touches(cursor, &sample, crop))
          throw Failure("capture_failed", "hidden pointer touched capture");
        cursor.visible = true;
        cursor.shape.Width = 1;
        cursor.shape.Pitch = 4;
        cursor.pixels.resize(4);
        if (touches(cursor, &sample, crop))
          throw Failure("capture_failed", "old pointer shape touched capture");
        cursor.shape.Width = 2;
        cursor.shape.Pitch = 8;
        cursor.pixels.resize(8);
        if (!touches(cursor, &sample, crop))
          throw Failure("capture_failed", "shape-only pointer change missed capture");
        cursor.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
        cursor.shape.Height = 4;
        cursor.shape.Pitch = 1;
        cursor.pixels.resize(4);
        cursor.position = POINT{1900, -2};
        if (touches(cursor, &sample, crop))
          throw Failure("capture_failed", "monochrome pointer buffer height touched capture");
        cursor.position.y = -1;
        if (!touches(cursor, &sample, crop))
          throw Failure("capture_failed", "monochrome drawn height missed capture");
        ComPtr<IWICImagingFactory> imaging;
        require(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_PPV_ARGS(imaging.GetAddressOf())), "WIC factory");
        BYTE pixels[16]{0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255};
        SYSTEM_INFO system{};
        GetSystemInfo(&system);
        if (system.dwPageSize < 20) throw Failure("capture_failed", "guard page is too small for pixel test");
        const auto release = [](BYTE* bytes) { if (bytes) VirtualFree(bytes, 0, MEM_RELEASE); };
        std::unique_ptr<BYTE, decltype(release)> guarded(
            static_cast<BYTE*>(VirtualAlloc(nullptr, size_t(system.dwPageSize) * 2,
                                            MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE)), release);
        if (!guarded) throw Failure("capture_failed", "guarded pixel allocation failed");
        DWORD prior = 0;
        if (!VirtualProtect(guarded.get() + system.dwPageSize, system.dwPageSize, PAGE_NOACCESS, &prior))
          throw Failure("capture_failed", "pixel guard page could not be protected");
        BYTE* padded = guarded.get() + system.dwPageSize - 20;
        std::memcpy(padded, pixels, 8);
        std::memcpy(padded + 12, pixels + 8, 8);
        BYTE packed[16]{};
        blit(packed, 2, 2, RECT{0, 0, 2, 2}, RECT{0, 0, 2, 2}, padded, 12);
        if (std::memcmp(packed, pixels, sizeof(pixels)))
          throw Failure("capture_failed", "padded final-row copy changed capture pixels");
        std::vector<unsigned char> image(kImageBytes);
        bool blocked = false;
        try { encode(imaging.Get(), 2, 2, 12, padded, image); }
        catch (const Failure& error) { blocked = error.code == "unsupported_surface"; }
        if (!blocked) throw Failure("capture_failed", "padded WIC input was not refused");
        if (encode(imaging.Get(), 2, 2, 8, packed, image) < 30)
          throw Failure("capture_failed", "self-test PNG is too short");
      }
      clearreceipt();
      CoUninitialize();
      return 0;
    }
    if (argc != 1) throw Failure("invalid_argument", "unsupported capture argument");
    run(pipe);
    clearreceipt();
    CoUninitialize();
    return 0;
  } catch (const Failure& error) {
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test")
      std::fprintf(stderr, "Native capture self-test: %s\n", error.what());
    terminal(pipe, error.code);
    clearreceipt();
    CoUninitialize();
    return 1;
  } catch (const std::exception& error) {
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test")
      std::fprintf(stderr, "Native capture self-test: %s\n", error.what());
    // Pipe closure is cancellation. A live consumer receives one terminal error packet.
    if (std::string(error.what()) != "stdout pipe closed") {
      terminal(pipe, "capture_failed");
    }
    clearreceipt();
    CoUninitialize();
    return 1;
  }
}
