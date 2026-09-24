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
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

static constexpr UINT kPixels = 8'294'400;
static constexpr UINT kEdge = 4'096;
static constexpr DWORD kImageBytes = 15'000'000;
static volatile LONG stopped = 0;

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

struct Target {
  HWND handle;
  HMONITOR monitor;
  RECT rect;
  std::string id;
  std::string location;
};

static RECT intersect(RECT rect, RECT desktop) {
  RECT visible{std::max(rect.left, desktop.left), std::max(rect.top, desktop.top),
               std::min(rect.right, desktop.right), std::min(rect.bottom, desktop.bottom)};
  if (visible.right <= visible.left || visible.bottom <= visible.top)
    throw Failure("unsupported_surface", "foreground window has no observable area");
  return visible;
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
  rect = intersect(rect, RECT{left, top, left + desktopWidth, top + desktopHeight});
  auto width = rect.right - rect.left;
  auto height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0 || width > kEdge || height > kEdge || uint64_t(width) * height > kPixels)
    throw Failure("unsupported_surface", "foreground window exceeds capture bounds");
  HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
  if (!monitor) throw Failure("unsupported_surface", "foreground window has no monitor");
  MONITORINFO info{sizeof(info)};
  if (!GetMonitorInfoW(monitor, &info)) throw std::runtime_error("monitor bounds unavailable");
  if (rect.left < info.rcMonitor.left || rect.top < info.rcMonitor.top || rect.right > info.rcMonitor.right || rect.bottom > info.rcMonitor.bottom)
    throw Failure("unsupported_surface", "foreground window spans monitors or exceeds the monitor");
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
  return {handle, monitor, rect, id.str(), location.str()};
}

static void same(const Target& original) {
  auto current = target();
  if (current.handle != original.handle || current.monitor != original.monitor || current.location != original.location)
    throw Failure("target_changed", "foreground target changed during capture");
}

struct Lease {
  IDXGIOutputDuplication* duplicate;
  explicit Lease(IDXGIOutputDuplication* value) : duplicate(value) {}
  ~Lease() { if (duplicate) duplicate->ReleaseFrame(); }
  Lease(const Lease&) = delete;
  Lease& operator=(const Lease&) = delete;
};

static BOOL WINAPI control(DWORD signal) {
  if (signal != CTRL_C_EVENT && signal != CTRL_BREAK_EVENT && signal != CTRL_CLOSE_EVENT) return FALSE;
  InterlockedExchange(&stopped, 1);
  return TRUE;
}

static void run(HANDLE pipe) {
  auto original = target();
  ComPtr<IDXGIFactory1> factory;
  require(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.GetAddressOf())), "CreateDXGIFactory1");
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  for (UINT a = 0; !output; ++a) {
    adapter.Reset();
    HRESULT status = factory->EnumAdapters1(a, adapter.GetAddressOf());
    if (status == DXGI_ERROR_NOT_FOUND) break;
    require(status, "EnumAdapters1");
    for (UINT o = 0; !output; ++o) {
      ComPtr<IDXGIOutput> next;
      status = adapter->EnumOutputs(o, next.GetAddressOf());
      if (status == DXGI_ERROR_NOT_FOUND) break;
      require(status, "EnumOutputs");
      DXGI_OUTPUT_DESC desc{};
      require(next->GetDesc(&desc), "GetDesc");
      if (desc.Monitor != original.monitor) continue;
      if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY) throw Failure("unsupported_surface", "rotated monitor is unsupported");
      require(next.As(&output), "IDXGIOutput1");
      if (original.rect.left < desc.DesktopCoordinates.left || original.rect.top < desc.DesktopCoordinates.top ||
          original.rect.right > desc.DesktopCoordinates.right || original.rect.bottom > desc.DesktopCoordinates.bottom)
        throw Failure("unsupported_surface", "foreground bounds do not match DXGI output");
      break;
    }
  }
  if (!output) throw Failure("unsupported_surface", "foreground monitor has no DXGI output");
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  require(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            nullptr, 0, D3D11_SDK_VERSION, device.GetAddressOf(), nullptr, context.GetAddressOf()), "D3D11CreateDevice");
  ComPtr<IDXGIOutputDuplication> duplicate;
  require(output->DuplicateOutput(device.Get(), duplicate.GetAddressOf()), "DuplicateOutput");
  DXGI_OUTDUPL_DESC desc{};
  duplicate->GetDesc(&desc);
  if (desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
      uint64_t(desc.ModeDesc.Width) * desc.ModeDesc.Height > 16'588'800)
    throw Failure("unsupported_surface", "DXGI output format or dimensions are unsupported");
  auto width = UINT(original.rect.right - original.rect.left);
  auto height = UINT(original.rect.bottom - original.rect.top);
  D3D11_TEXTURE2D_DESC texture{};
  texture.Width = width;
  texture.Height = height;
  texture.MipLevels = 1;
  texture.ArraySize = 1;
  texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  texture.SampleDesc.Count = 1;
  texture.Usage = D3D11_USAGE_STAGING;
  texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  require(device->CreateTexture2D(&texture, nullptr, staging.GetAddressOf()), "CreateTexture2D");
  ComPtr<IWICImagingFactory> imaging;
  require(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(imaging.GetAddressOf())), "WIC factory");
  DXGI_OUTPUT_DESC outputDesc{};
  require(output->GetDesc(&outputDesc), "output GetDesc");
  D3D11_BOX box{UINT(original.rect.left - outputDesc.DesktopCoordinates.left),
                UINT(original.rect.top - outputDesc.DesktopCoordinates.top), 0,
                UINT(original.rect.right - outputDesc.DesktopCoordinates.left),
                UINT(original.rect.bottom - outputDesc.DesktopCoordinates.top), 1};
  std::vector<unsigned char> image(kImageBytes);
  uint64_t sequence = 0;
  while (!InterlockedCompareExchange(&stopped, 0, 0)) {
    same(original);
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    auto begin = Clock::now();
    HRESULT status = duplicate->AcquireNextFrame(50, &info, resource.GetAddressOf());
    if (status == DXGI_ERROR_WAIT_TIMEOUT) continue;
    require(status, "AcquireNextFrame");
    Lease lease(duplicate.Get());
    auto acquired = Clock::now();
    same(original);
    ComPtr<ID3D11Texture2D> source;
    require(resource.As(&source), "capture texture");
    D3D11_TEXTURE2D_DESC current{};
    source->GetDesc(&current);
    if (current.Format != texture.Format || current.Width != desc.ModeDesc.Width ||
        current.Height != desc.ModeDesc.Height || box.right > current.Width || box.bottom > current.Height)
      throw Failure("display_changed", "DXGI source dimensions changed before copy");
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, source.Get(), 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    require(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map");
    DWORD size = 0;
    try {
      size = encode(imaging.Get(), width, height, mapped.RowPitch, static_cast<BYTE*>(mapped.pData), image);
    } catch (...) {
      context->Unmap(staging.Get(), 0);
      throw;
    }
    context->Unmap(staging.Get(), 0);
    auto prepared = Clock::now();
    same(original);
    if (InterlockedCompareExchange(&stopped, 0, 0)) break;
    std::ostringstream header;
    header << std::fixed << std::setprecision(3)
           << "{\"v\":1,\"type\":\"frame\",\"sequence\":" << ++sequence
           << ",\"windowID\":" << quoted(original.id)
           << ",\"location\":" << quoted(original.location)
           << ",\"width\":" << width << ",\"height\":" << height
           << ",\"mime\":\"image/png\",\"acquisitionMs\":" << ms(begin, acquired)
           << ",\"preparationMs\":" << ms(acquired, prepared) << '}';
    packet(pipe, header.str(), image.data(), size);
  }
}

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
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
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
      {
        RECT visible = intersect(RECT{-8, -8, 1928, 1088}, RECT{0, 0, 1920, 1080});
        if (visible.left != 0 || visible.top != 0 || visible.right != 1920 || visible.bottom != 1080)
          throw Failure("capture_failed", "visible desktop clipping self-test failed");
        bool refused = false;
        try {
          intersect(RECT{-100, -100, -1, -1}, RECT{0, 0, 1920, 1080});
        } catch (const Failure& error) {
          refused = error.code == "unsupported_surface";
        }
        if (!refused) throw Failure("capture_failed", "disjoint window clipping self-test failed");
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
