// Standalone Windows capture experiment. It is not linked into the Raya extension.
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <mutex>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock = std::chrono::steady_clock;

struct Sample {
  double acquire;
  double copy;
  double map;
  unsigned dirty;
  unsigned long long bytes;
  unsigned checksum;
};

static double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}

static double percentile(std::vector<double> values, double p) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  return values[std::min(values.size() - 1, size_t((values.size() - 1) * p + 0.5))];
}

static void report(const char* name, const std::vector<Sample>& samples, int timeouts, int width, int height) {
  std::vector<double> acquire, copy, map;
  unsigned long long dirty = 0, bytes = 0;
  unsigned checksum = 0;
  for (auto& sample : samples) {
    acquire.push_back(sample.acquire);
    copy.push_back(sample.copy);
    map.push_back(sample.map);
    dirty += sample.dirty;
    bytes += sample.bytes;
    checksum ^= sample.checksum;
  }
  std::printf("{\"api\":\"%s\",\"frames\":%zu,\"timeouts\":%d,\"width\":%d,\"height\":%d,"
              "\"acquire_p50_ms\":%.3f,\"acquire_p95_ms\":%.3f,\"copy_p50_ms\":%.3f,\"copy_p95_ms\":%.3f,"
              "\"map_p50_ms\":%.3f,\"map_p95_ms\":%.3f,\"dirty_regions\":%llu,\"read_bytes\":%llu,\"checksum\":%u}\n",
              name, samples.size(), timeouts, width, height, percentile(acquire, .5), percentile(acquire, .95),
              percentile(copy, .5), percentile(copy, .95), percentile(map, .5), percentile(map, .95), dirty, bytes, checksum);
}

static com_ptr<ID3D11Texture2D> staging(ID3D11Device* device, ID3D11Texture2D* source) {
  D3D11_TEXTURE2D_DESC desc{};
  source->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  com_ptr<ID3D11Texture2D> texture;
  check_hresult(device->CreateTexture2D(&desc, nullptr, texture.put()));
  return texture;
}

static Sample readback(ID3D11Device* device, ID3D11DeviceContext* context, ID3D11Texture2D* source,
                       double acquire, unsigned dirty) {
  auto copyStart = Clock::now();
  auto target = staging(device, source);
  context->CopyResource(target.get(), source);
  auto copyEnd = Clock::now();
  D3D11_TEXTURE2D_DESC desc{};
  target->GetDesc(&desc);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  check_hresult(context->Map(target.get(), 0, D3D11_MAP_READ, 0, &mapped));
  unsigned checksum = 2166136261u;
  auto data = static_cast<const unsigned char*>(mapped.pData);
  for (unsigned y = 0; y < desc.Height; ++y) {
    auto row = data + size_t(y) * mapped.RowPitch;
    for (unsigned x = 0; x < desc.Width * 4; x += 64) checksum = (checksum ^ row[x]) * 16777619u;
  }
  context->Unmap(target.get(), 0);
  return {acquire, ms(copyStart, copyEnd), ms(copyEnd, Clock::now()), dirty,
          static_cast<unsigned long long>(desc.Width) * desc.Height * 4, checksum};
}

static int benchWgc(HMONITOR monitor, ID3D11Device* device, ID3D11DeviceContext* context, int count) {
  auto factory = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  check_hresult(factory->CreateForMonitor(monitor, guid_of<GraphicsCaptureItem>(), put_abi(item)));
  auto dxgi = com_ptr<IDXGIDevice>{};
  check_hresult(device->QueryInterface(dxgi.put()));
  com_ptr<IInspectable> native;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), native.put()));
  auto bridge = native.as<IDirect3DDevice>();
  auto size = item.Size();
  auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(bridge, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
  auto session = pool.CreateCaptureSession(item);
  if (auto mode = session.try_as<IGraphicsCaptureSession4>()) mode.DirtyRegionMode(GraphicsCaptureDirtyRegionMode::ReportOnly);
  std::mutex mutex;
  std::condition_variable changed;
  unsigned ready = 0;
  auto event = pool.FrameArrived([&](auto&&, auto&&) {
    std::lock_guard lock(mutex);
    ++ready;
    changed.notify_one();
  });
  session.StartCapture();
  std::vector<Sample> samples;
  int timeouts = 0;
  for (int i = 0; i < count; ++i) {
    auto start = Clock::now();
    {
      std::unique_lock lock(mutex);
      if (!changed.wait_for(lock, std::chrono::milliseconds(1500), [&] { return ready > 0; })) {
        ++timeouts;
        continue;
      }
      ready = 0;
    }
    auto frame = pool.TryGetNextFrame();
    if (!frame) { ++timeouts; continue; }
    auto acquired = Clock::now();
    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> texture;
    check_hresult(access->GetInterface(guid_of<ID3D11Texture2D>(), texture.put_void()));
    unsigned dirty = 0;
    if (auto regions = frame.try_as<IDirect3D11CaptureFrame2>()) dirty = regions.DirtyRegions().Size();
    samples.push_back(readback(device, context, texture.get(), ms(start, acquired), dirty));
  }
  pool.FrameArrived(event);
  session.Close();
  pool.Close();
  report("wgc", samples, timeouts, size.Width, size.Height);
  return int(samples.size());
}

static int benchDxgi(IDXGIOutput1* output, ID3D11Device* device, ID3D11DeviceContext* context, int count) {
  com_ptr<IDXGIOutputDuplication> duplicate;
  check_hresult(output->DuplicateOutput(device, duplicate.put()));
  DXGI_OUTDUPL_DESC desc{};
  duplicate->GetDesc(&desc);
  std::vector<Sample> samples;
  int timeouts = 0;
  for (int i = 0; i < count; ++i) {
    DXGI_OUTDUPL_FRAME_INFO info{};
    com_ptr<IDXGIResource> resource;
    auto start = Clock::now();
    auto result = duplicate->AcquireNextFrame(1500, &info, resource.put());
    if (result == DXGI_ERROR_WAIT_TIMEOUT) { ++timeouts; continue; }
    check_hresult(result);
    auto acquired = Clock::now();
    auto texture = resource.as<ID3D11Texture2D>();
    unsigned dirty = 0;
    if (info.TotalMetadataBufferSize) {
      std::vector<unsigned char> buffer(info.TotalMetadataBufferSize);
      UINT bytes = 0;
      auto status = duplicate->GetFrameDirtyRects(UINT(buffer.size()), reinterpret_cast<RECT*>(buffer.data()), &bytes);
      if (SUCCEEDED(status)) dirty = bytes / sizeof(RECT);
    }
    try {
      samples.push_back(readback(device, context, texture.get(), ms(start, acquired), dirty));
    } catch (...) {
      duplicate->ReleaseFrame();
      throw;
    }
    check_hresult(duplicate->ReleaseFrame());
  }
  report("dxgi", samples, timeouts, desc.ModeDesc.Width, desc.ModeDesc.Height);
  return int(samples.size());
}

int main(int argc, char** argv) {
  int count = argc > 1 ? std::atoi(argv[1]) : 12;
  if (count < 1 || count > 1000) { std::fprintf(stderr, "frame count must be 1..1000\n"); return 2; }
  try {
    init_apartment();
    auto monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
    com_ptr<IDXGIFactory1> factory;
    check_hresult(CreateDXGIFactory1(guid_of<IDXGIFactory1>(), factory.put_void()));
    com_ptr<IDXGIAdapter1> adapter;
    com_ptr<IDXGIOutput1> output;
    for (UINT a = 0; !output && factory->EnumAdapters1(a, adapter.put()) != DXGI_ERROR_NOT_FOUND; ++a) {
      com_ptr<IDXGIOutput> next;
      for (UINT o = 0; adapter->EnumOutputs(o, next.put()) != DXGI_ERROR_NOT_FOUND; ++o) {
        DXGI_OUTPUT_DESC desc{};
        check_hresult(next->GetDesc(&desc));
        if (desc.Monitor == monitor) { output = next.as<IDXGIOutput1>(); break; }
        next = nullptr;
      }
      if (!output) adapter = nullptr;
    }
    if (!output) throw std::runtime_error("foreground monitor has no DXGI output");
    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    check_hresult(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                    nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
    std::printf("{\"monitor\":\"%p\",\"frames_requested\":%d}\n", monitor, count);
    std::fflush(stdout);
    int captured = 0;
    try { captured += benchWgc(monitor, device.get(), context.get(), count); }
    catch (const hresult_error& err) { std::fprintf(stderr, "WGC unavailable: HRESULT 0x%08X\n", unsigned(err.code().value)); }
    try { captured += benchDxgi(output.get(), device.get(), context.get(), count); }
    catch (const hresult_error& err) { std::fprintf(stderr, "DXGI unavailable: HRESULT 0x%08X\n", unsigned(err.code().value)); }
    return captured ? 0 : 1;
  } catch (const hresult_error& err) {
    std::fprintf(stderr, "capture benchmark failed: HRESULT 0x%08X\n", unsigned(err.code().value));
    return 1;
  } catch (const std::exception& err) {
    std::fprintf(stderr, "capture benchmark failed: %s\n", err.what());
    return 1;
  }
}
