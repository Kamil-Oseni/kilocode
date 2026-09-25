// Raya's isolated Windows input broker. Native input is gated by a bound session and exact target.
#define NOMINMAX
#include <windows.h>
#include <wincrypt.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <limits>
#include <map>
#include <cmath>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {
constexpr uint32_t kHeader = 4096;
constexpr size_t kHistory = 1024;
constexpr std::string_view kZero = "00000000000000000000000000000000";

struct Frame {
  uint32_t version = 1;
  std::string type;
  std::string session;
  std::string request;
  std::string nonce;
  std::string window;
  uint64_t sequence = 0;
  uint64_t scene = 0;
  uint32_t pid = 0;
  std::string identity;
  RECT rect{};
  std::string action;
  std::array<int64_t, 5> args{};
  uint64_t observed = 0;
  uint64_t until = 0;
  std::u16string text;
};

struct Reply {
  std::string type;
  std::string session;
  std::string request;
  uint64_t sequence = 0;
  std::string code;
  uint32_t accepted = 0;
  uint32_t attempted = 0;
};

bool id(std::string_view value) {
  if (value.size() != 32) return false;
  return std::all_of(value.begin(), value.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

bool number(std::string_view value, uint64_t& result) {
  if (value.empty() || (value.size() > 1 && value[0] == '0')) return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool signed_number(std::string_view value, int64_t& result) {
  if (value.empty() || (value.size() > 1 && value[0] == '0') ||
      (value.size() > 1 && value[0] == '-' && value[1] == '0')) return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool window(std::string_view value, uintptr_t& result) {
  if (value.empty() || value.size() > sizeof(uintptr_t) * 2 || (value.size() > 1 && value[0] == '0')) return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result, 16);
  if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size()) return false;
  return std::all_of(value.begin(), value.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

// The protocol has a deliberately narrow, flat JSON grammar. Escapes, arrays,
// nested values, duplicate keys and unknown keys are invalid, not normalized.
enum class Parse { valid, malformed, version };

Parse parse(std::string_view input, Frame& frame) {
  if (input.size() > kHeader || input.empty()) return Parse::malformed;
  size_t pos = 0;
  const auto space = [&]() {
    while (pos < input.size() && (input[pos] == ' ' || input[pos] == '\t' || input[pos] == '\r' || input[pos] == '\n')) ++pos;
  };
  const auto quoted = [&](std::string& value) {
    if (pos >= input.size() || input[pos++] != '"') return false;
    const size_t begin = pos;
    while (pos < input.size() && input[pos] != '"') {
      const unsigned char c = static_cast<unsigned char>(input[pos]);
      if (c < 0x20 || c > 0x7e || c == '\\') return false;
      ++pos;
    }
    if (pos == input.size()) return false;
    value.assign(input.substr(begin, pos - begin));
    ++pos;
    return true;
  };
  space();
  if (pos >= input.size() || input[pos++] != '{') return Parse::malformed;
  std::map<std::string, std::string> values;
  bool comma = false;
  while (true) {
    space();
    if (pos >= input.size()) return Parse::malformed;
    if (input[pos] == '}') {
      if (comma) return Parse::malformed;
      ++pos;
      break;
    }
    comma = false;
    std::string key;
    if (!quoted(key)) return Parse::malformed;
    space();
    if (pos >= input.size() || input[pos++] != ':') return Parse::malformed;
    space();
    if (pos >= input.size()) return Parse::malformed;
    std::string value;
    if (input[pos] == '"') {
      if (!quoted(value)) return Parse::malformed;
      value.insert(value.begin(), '"');
    } else {
      const size_t begin = pos;
      while (pos < input.size() && input[pos] >= '0' && input[pos] <= '9') ++pos;
      if (begin == pos) return Parse::malformed;
      value.assign(input.substr(begin, pos - begin));
    }
    if (!values.emplace(std::move(key), std::move(value)).second) return Parse::malformed;
    space();
    if (pos >= input.size()) return Parse::malformed;
    if (input[pos] == '}') { ++pos; break; }
    if (input[pos++] != ',') return Parse::malformed;
    comma = true;
  }
  space();
  if (pos != input.size() || !values.contains("type") || values["type"].empty() || values["type"][0] != '"') return Parse::malformed;
  const bool dispatch = values["type"] == "\"dispatch";
  if (values.size() != (dispatch ? 22 : 9)) return Parse::malformed;
  static constexpr std::array<std::string_view, 9> keys = {
    "v", "type", "session", "request", "sequence", "nonce", "windowID", "pid", "scene"
  };
  for (auto key : keys) if (!values.contains(std::string(key))) return Parse::malformed;
  if (dispatch) {
    static constexpr std::array<std::string_view, 13> extras = {
      "identity", "left", "top", "right", "bottom", "action", "a", "b", "c", "d", "e", "observedAt", "validUntil"
    };
    for (auto key : extras) if (!values.contains(std::string(key))) return Parse::malformed;
  }
  if (!values["v"].empty() && values["v"][0] == '"') return Parse::malformed;
  if (values["v"] != "2") return Parse::version;
  frame.version = 2;
  for (auto key : {"type", "session", "request", "nonce", "windowID"})
    if (values[key].empty() || values[key][0] != '"') return Parse::malformed;
  for (auto key : {"v", "sequence", "pid", "scene"})
    if (!values[key].empty() && values[key][0] == '"') return Parse::malformed;
  frame.type = values["type"].substr(1);
  frame.session = values["session"].substr(1);
  frame.request = values["request"].substr(1);
  frame.nonce = values["nonce"].substr(1);
  frame.window = values["windowID"].substr(1);
  uint64_t pid = 0;
  if (!number(values["sequence"], frame.sequence) || !number(values["pid"], pid) ||
      !number(values["scene"], frame.scene) || pid > std::numeric_limits<uint32_t>::max()) return Parse::malformed;
  frame.pid = static_cast<uint32_t>(pid);
  if (dispatch) {
    for (auto key : {"identity", "action"})
      if (values[key].empty() || values[key][0] != '"') return Parse::malformed;
    for (auto key : {"left", "top", "right", "bottom", "a", "b", "c", "d", "e", "observedAt", "validUntil"})
      if (values[key].empty() || values[key][0] == '"') return Parse::malformed;
    const auto field = [&](const char* key, int64_t& value) { return signed_number(values[key], value); };
    std::array<int64_t, 9> fields{};
    const std::array<const char*, 9> names = {"left", "top", "right", "bottom", "a", "b", "c", "d", "e"};
    for (size_t i = 0; i < names.size(); ++i) if (!field(names[i], fields[i])) return Parse::malformed;
    if (fields[0] < INT32_MIN || fields[0] > INT32_MAX || fields[1] < INT32_MIN || fields[1] > INT32_MAX ||
        fields[2] < INT32_MIN || fields[2] > INT32_MAX || fields[3] < INT32_MIN || fields[3] > INT32_MAX ||
        fields[2] <= fields[0] || fields[3] <= fields[1] ||
        !number(values["observedAt"], frame.observed) || !number(values["validUntil"], frame.until)) return Parse::malformed;
    frame.rect = RECT{static_cast<LONG>(fields[0]), static_cast<LONG>(fields[1]),
                      static_cast<LONG>(fields[2]), static_cast<LONG>(fields[3])};
    std::copy(fields.begin() + 4, fields.end(), frame.args.begin());
    frame.identity = values["identity"].substr(1);
    frame.action = values["action"].substr(1);
    if (frame.identity.size() != 64 || !std::all_of(frame.identity.begin(), frame.identity.end(), [](char c) {
          return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
        })) return Parse::malformed;
  }
  uintptr_t target = 0;
  return id(frame.session) && id(frame.request) && id(frame.nonce) &&
    frame.session != kZero && frame.request != kZero && frame.nonce != kZero &&
    window(frame.window, target) ? Parse::valid : Parse::malformed;
}

std::string json(const Reply& reply) {
  return "{\"v\":2,\"type\":\"" + reply.type + "\",\"session\":\"" + reply.session +
    "\",\"request\":\"" + reply.request + "\",\"sequence\":" +
    std::to_string(reply.sequence) + ",\"code\":\"" + reply.code + "\",\"accepted\":" +
    std::to_string(reply.accepted) + ",\"attempted\":" + std::to_string(reply.attempted) + "}";
}

bool exact(const Frame& frame) {
  uintptr_t value = 0;
  if (!window(frame.window, value) || !value) return false;
  const HWND target = reinterpret_cast<HWND>(value);
  if (!IsWindow(target) || !IsWindowVisible(target)) return false;
  DWORD pid = 0;
  if (!GetWindowThreadProcessId(target, &pid) || pid != frame.pid) return false;
  if (GetForegroundWindow() != target) return false;
  RECT rect{};
  if (!GetWindowRect(target, &rect)) return false;
  const LONG left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const LONG top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const LONG right = left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const LONG bottom = top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  rect.left = std::max(rect.left, left);
  rect.top = std::max(rect.top, top);
  rect.right = std::min(rect.right, right);
  rect.bottom = std::min(rect.bottom, bottom);
  if (rect.left != frame.rect.left || rect.top != frame.rect.top ||
      rect.right != frame.rect.right || rect.bottom != frame.rect.bottom) return false;
  wchar_t cls[512]{};
  if (!GetClassNameW(target, cls, 512)) return false;
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  FILETIME creation{}, exit{}, kernel{}, user{};
  const bool times = GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0;
  CloseHandle(process);
  if (!times) return false;
  const uint64_t ticks = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) |
                          creation.dwLowDateTime;
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, cls, -1, nullptr, 0, nullptr, nullptr);
  if (bytes <= 1 || bytes > 2048) return false;
  std::string name(static_cast<size_t>(bytes), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, cls, -1, name.data(), bytes, nullptr, nullptr)) return false;
  name.pop_back();
  const std::string source = "pid:" + std::to_string(pid) + ";start:" +
    std::to_string(ticks + 504911232000000000ULL) + ";class:" + name;
  HCRYPTPROV provider = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return false;
  HCRYPTHASH hash = 0;
  const bool created = CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) != 0;
  std::array<BYTE, 32> digest{};
  DWORD size = static_cast<DWORD>(digest.size());
  const bool hashed = created && CryptHashData(hash, reinterpret_cast<const BYTE*>(source.data()),
    static_cast<DWORD>(source.size()), 0) && CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &size, 0);
  if (created) CryptDestroyHash(hash);
  CryptReleaseContext(provider, 0);
  if (!hashed || size != digest.size()) return false;
  static constexpr char digits[] = "0123456789ABCDEF";
  std::string identity;
  identity.reserve(64);
  for (BYTE byte : digest) {
    identity.push_back(digits[byte >> 4]);
    identity.push_back(digits[byte & 15]);
  }
  return identity == frame.identity;
}

using Sender = UINT (*)(UINT, LPINPUT, int);
using Waiter = void (*)(const Frame&);

bool valid(const Frame& frame) {
  const auto& a = frame.args;
  if (frame.until < frame.observed || frame.until - frame.observed > 10000) return false;
  if (frame.action == "move" || frame.action == "click" || frame.action == "double_click")
    return a[0] >= 0 && a[0] <= 1000000 && a[1] >= 0 && a[1] <= 1000000 &&
      a[2] >= 0 && a[2] <= 1 && a[3] == 0 && a[4] == 0 && frame.text.empty();
  if (frame.action == "drag")
    return a[0] >= 0 && a[0] <= 1000000 && a[1] >= 0 && a[1] <= 1000000 &&
      a[2] >= 0 && a[2] <= 1000000 && a[3] >= 0 && a[3] <= 1000000 &&
      a[4] >= 0 && a[4] <= 1 && frame.text.empty();
  if (frame.action == "scroll") return a[0] >= -1200 && a[0] <= 1200 &&
    a[1] >= -1200 && a[1] <= 1200 && (a[0] || a[1]) && !a[2] && !a[3] && !a[4] && frame.text.empty();
  if (frame.action == "chord") return a[0] >= 1 && a[0] <= 255 && a[1] >= 0 && a[1] <= 15 &&
    !a[2] && !a[3] && !a[4] && frame.text.empty();
  if (frame.action == "text") return !a[0] && !a[1] && !a[2] && !a[3] && !a[4] &&
    !frame.text.empty() && frame.text.size() <= 256;
  return false;
}

uint64_t now() {
  FILETIME time{};
  GetSystemTimePreciseAsFileTime(&time);
  const uint64_t ticks = (static_cast<uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
  return ticks / 10000 - 11644473600000ULL;
}

bool idle(const Frame& frame) {
  if (frame.action == "click" || frame.action == "double_click" || frame.action == "drag")
    return !(GetAsyncKeyState(frame.args[frame.action == "drag" ? 4 : 2] ? VK_RBUTTON : VK_LBUTTON) & 0x8000);
  if (frame.action == "chord") {
    const int key = static_cast<int>(frame.args[0]);
    if (GetAsyncKeyState(key) & 0x8000) return false;
    for (int modifier : {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN})
      if (GetAsyncKeyState(modifier) & 0x8000) return false;
  }
  return true;
}

std::vector<INPUT> events(const Frame& frame) {
  std::vector<INPUT> result;
  const auto addmouse = [&](DWORD flags, LONG x = 0, LONG y = 0, DWORD data = 0) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dx = x;
    input.mi.dy = y;
    input.mi.mouseData = data;
    input.mi.dwFlags = flags;
    result.push_back(input);
  };
  const auto addkey = [&](WORD key, DWORD flags) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = key;
    input.ki.dwFlags = flags;
    result.push_back(input);
  };
  const auto position = [&](int64_t x, int64_t y) {
    const int64_t px = frame.rect.left + (x * (frame.rect.right - frame.rect.left - 1) + 500000) / 1000000;
    const int64_t py = frame.rect.top + (y * (frame.rect.bottom - frame.rect.top - 1) + 500000) / 1000000;
    const int64_t left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int64_t top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int64_t width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int64_t height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width <= 1 || height <= 1) return false;
    addmouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
      static_cast<LONG>(((px - left) * 65535 + (width - 1) / 2) / (width - 1)),
      static_cast<LONG>(((py - top) * 65535 + (height - 1) / 2) / (height - 1)));
    return true;
  };
  if (frame.action == "move" || frame.action == "click" || frame.action == "double_click" || frame.action == "drag") {
    if (!position(frame.args[0], frame.args[1])) return {};
    if (frame.action == "move") return result;
    const bool right = frame.args[frame.action == "drag" ? 4 : 2] == 1;
    const DWORD down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
    const DWORD up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
    addmouse(down);
    if (frame.action == "drag" && !position(frame.args[2], frame.args[3])) return {};
    addmouse(up);
    if (frame.action == "double_click") { addmouse(down); addmouse(up); }
    return result;
  }
  if (frame.action == "scroll") {
    if (frame.args[0]) addmouse(MOUSEEVENTF_HWHEEL, 0, 0, static_cast<DWORD>(frame.args[0]));
    if (frame.args[1]) addmouse(MOUSEEVENTF_WHEEL, 0, 0, static_cast<DWORD>(frame.args[1]));
    return result;
  }
  if (frame.action == "chord") {
    const std::array<WORD, 4> keys = {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN};
    for (size_t i = 0; i < keys.size(); ++i) if (frame.args[1] & (1LL << i)) addkey(keys[i], 0);
    addkey(static_cast<WORD>(frame.args[0]), 0);
    addkey(static_cast<WORD>(frame.args[0]), KEYEVENTF_KEYUP);
    for (size_t i = keys.size(); i-- > 0;) if (frame.args[1] & (1LL << i)) addkey(keys[i], KEYEVENTF_KEYUP);
    return result;
  }
  if (frame.action == "text") {
    for (char16_t code : frame.text) {
      INPUT down{};
      down.type = INPUT_KEYBOARD;
      down.ki.wScan = static_cast<WORD>(code);
      down.ki.dwFlags = KEYEVENTF_UNICODE;
      result.push_back(down);
      down.ki.dwFlags |= KEYEVENTF_KEYUP;
      result.push_back(down);
    }
  }
  return result;
}

class Broker {
public:
  explicit Broker(Sender sender = SendInput, bool (*target)(const Frame&) = exact,
                  bool (*available)(const Frame&) = idle, uint64_t (*clock)() = now,
                  Waiter waiter = nullptr)
    : sender(sender), target(target), available(available), clock(clock), waiter(waiter) {}
  Reply handle(const Frame& frame) {
    std::unique_lock<std::mutex> lock(mutex);
    const auto reply = [&](std::string type, std::string code) {
      return Reply{std::move(type), frame.session, frame.request, frame.sequence, std::move(code)};
    };
    if (frame.type == "hello") {
      if (bound || frame.sequence || frame.window != "0" || frame.pid || frame.scene || frame.session == kZero || frame.nonce == kZero)
        return reply("refused", "bad_session");
      bound = true;
      session = frame.session;
      nonce = frame.nonce;
      seen.push_back(frame.request);
      return reply("ready", "ok");
    }
    if (!bound || frame.session != session) return reply("refused", "bad_session");
    if (frame.nonce != nonce) return reply("refused", "bad_nonce");
    if (std::find(seen.begin(), seen.end(), frame.request) != seen.end()) return reply("refused", "duplicate");
    if (!frame.sequence || frame.sequence <= sequence) return reply("refused", "stale");
    if (frame.type != "dispatch" && frame.type != "cancel" && frame.type != "quiescent")
      return reply("refused", "bad_frame");
    if (frame.type != "dispatch" && (frame.window != "0" || frame.pid || frame.scene))
      return reply("refused", "bad_target");
    sequence = frame.sequence;
    seen.push_back(frame.request);
    if (seen.size() > kHistory) seen.erase(seen.begin());
    if (frame.type == "cancel") {
      cancelled.store(true, std::memory_order_release);
      return reply("cancelled", "ok");
    }
    if (frame.type == "quiescent") {
      if (active && waiter) waiter(frame);
      settled.wait(lock, [&] { return !active; });
      return uncertain ? reply("unknown", "partial") : reply("quiescent", "ok");
    }
    if (cancelled.load(std::memory_order_acquire) || uncertain)
      return reply("refused", cancelled.load(std::memory_order_acquire) ? "cancelled" : "unknown");
    if (active) return reply("refused", "input_busy");
    if (!frame.pid || !frame.scene || frame.window == "0") return reply("refused", "bad_target");
    if (frame.scene <= scene) return reply("refused", "stale");
    scene = frame.scene;
    if (!valid(frame)) return reply("refused", "unsupported");
    active = true;
    lock.unlock();
    const auto finish = [&](Reply result) {
      lock.lock();
      active = false;
      settled.notify_all();
      return result;
    };
    const uint64_t current = clock();
    if (frame.observed > current + 100 || frame.until < current) return finish(reply("refused", "expired"));
    if (!target(frame)) return finish(reply("refused", "changed_target"));
    if (!available(frame)) return finish(reply("refused", "input_busy"));
    std::vector<INPUT> input = events(frame);
    if (input.empty() || input.size() > 512) return finish(reply("refused", "unsupported"));
    uintptr_t tag = 0;
    const auto parsed = std::from_chars(frame.nonce.data(), frame.nonce.data() + 8, tag, 16);
    if (parsed.ec != std::errc{}) return finish(reply("refused", "bad_nonce"));
    for (auto& item : input) {
      if (item.type == INPUT_MOUSE) item.mi.dwExtraInfo = tag;
      if (item.type == INPUT_KEYBOARD) item.ki.dwExtraInfo = tag;
    }
    // This is the final check before SendInput. A partial batch has an unknown
    // outcome: never retry or release keys without physical-event ownership proof.
    if (!target(frame) || frame.until < clock()) return finish(reply("refused", "changed_target"));
    // This lock linearizes dispatch commitment against CANCEL. Once committed,
    // CANCEL may acknowledge, but QUIESCENT waits for this SendInput receipt.
    lock.lock();
    if (cancelled.load(std::memory_order_acquire)) {
      active = false;
      settled.notify_all();
      return reply("refused", "cancelled");
    }
    lock.unlock();
    const UINT attempted = static_cast<UINT>(input.size());
    const UINT accepted = sender(attempted, input.data(), sizeof(INPUT));
    Reply result = reply(accepted == attempted ? "confirmed" : accepted ? "unknown" : "refused",
                         accepted == attempted ? "ok" : accepted ? "partial" : "input_failed");
    result.accepted = accepted;
    result.attempted = attempted;
    lock.lock();
    if (accepted && accepted != attempted) uncertain = true;
    active = false;
    settled.notify_all();
    return result;
  }
  void stop() { cancelled.store(true, std::memory_order_release); }
private:
  std::mutex mutex;
  std::condition_variable settled;
  Sender sender;
  bool (*target)(const Frame&);
  bool (*available)(const Frame&);
  uint64_t (*clock)();
  Waiter waiter;
  bool bound = false;
  std::atomic<bool> cancelled = false;
  bool active = false;
  bool uncertain = false;
  uint64_t sequence = 0;
  uint64_t scene = 0;
  std::string session;
  std::string nonce;
  std::vector<std::string> seen;
};

bool read(HANDLE pipe, void* data, DWORD bytes, bool& eof) {
  auto* cursor = static_cast<unsigned char*>(data);
  DWORD total = 0;
  while (total < bytes) {
    DWORD count = 0;
    if (!ReadFile(pipe, cursor + total, bytes - total, &count, nullptr) || !count) {
      eof = total == 0;
      return false;
    }
    total += count;
  }
  return true;
}

bool write(HANDLE pipe, const void* data, DWORD bytes) {
  const auto* cursor = static_cast<const unsigned char*>(data);
  DWORD total = 0;
  while (total < bytes) {
    DWORD count = 0;
    if (!WriteFile(pipe, cursor + total, bytes - total, &count, nullptr) || !count) return false;
    total += count;
  }
  return true;
}

bool send(HANDLE pipe, const Reply& reply) {
  const std::string header = json(reply);
  const uint32_t length = static_cast<uint32_t>(header.size());
  const uint32_t empty = 0;
  return write(pipe, &length, sizeof(length)) && write(pipe, header.data(), length) && write(pipe, &empty, sizeof(empty));
}

bool allowed(const Frame&) { return true; }
UINT partial(UINT count, LPINPUT, int) { return count - 1; }
UINT rejected(UINT, LPINPUT, int) { return 0; }
std::mutex test_mutex;
std::condition_variable test_ready;
int test_checks = 0;
bool test_entered = false;
bool test_released = false;
std::atomic<int> test_sent = 0;
bool test_sender_entered = false;
bool test_sender_released = false;
bool test_waiting = false;
bool test_partial = false;
bool blocking(const Frame&) {
  if (++test_checks != 2) return true;
  std::unique_lock<std::mutex> lock(test_mutex);
  test_entered = true;
  test_ready.notify_all();
  test_ready.wait(lock, [] { return test_released; });
  return true;
}
UINT counting(UINT count, LPINPUT, int) {
  ++test_sent;
  return count;
}
UINT waiting_sender(UINT count, LPINPUT, int) {
  ++test_sent;
  std::unique_lock<std::mutex> lock(test_mutex);
  test_sender_entered = true;
  test_ready.notify_all();
  test_ready.wait(lock, [] { return test_sender_released; });
  return test_partial ? count - 1 : count;
}
void waiting(const Frame&) {
  std::lock_guard<std::mutex> lock(test_mutex);
  test_waiting = true;
  test_ready.notify_all();
}

int selftest() {
  const std::string first = "11111111111111111111111111111111";
  const std::string second = "22222222222222222222222222222222";
  const std::string third = "33333333333333333333333333333333";
  const auto raw = [&](std::string type, std::string request, uint64_t sequence,
                       std::string target = "0", uint32_t pid = 0, uint64_t scene = 0) {
    const std::string extra = type == "dispatch" ?
      ",\"identity\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\""
      ",\"left\":0,\"top\":0,\"right\":100,\"bottom\":100"
      ",\"action\":\"move\",\"a\":500000,\"b\":500000,\"c\":0,\"d\":0,\"e\":0"
      ",\"observedAt\":" + std::to_string(now()) + ",\"validUntil\":" + std::to_string(now() + 1000) : "";
    return "{\"v\":2,\"type\":\"" + type + "\",\"session\":\"" + first +
      "\",\"request\":\"" + request + "\",\"sequence\":" + std::to_string(sequence) +
      ",\"nonce\":\"" + third + "\",\"windowID\":\"" + target +
      "\",\"pid\":" + std::to_string(pid) + ",\"scene\":" + std::to_string(scene) + extra + "}";
  };
  Frame frame;
  Broker broker;
  const auto check = [&](const std::string& input, std::string_view type, std::string_view code) {
    if (parse(input, frame) != Parse::valid) return false;
    const Reply reply = broker.handle(frame);
    return reply.type == type && reply.code == code;
  };
  if (!check(raw("hello", second, 0), "ready", "ok")) return 1;
  if (!check(raw("hello", second, 0), "refused", "bad_session")) return 2;
  if (!check(raw("quiescent", second, 1), "refused", "duplicate")) return 3;
  if (!check(raw("dispatch", third, 1, "1", 1, 1), "refused", "changed_target")) return 4;
  if (!check(raw("quiescent", first, 1), "refused", "stale")) return 5;
  if (!check(raw("cancel", first, 2), "cancelled", "ok")) return 6;
  if (!check(raw("quiescent", third, 3), "refused", "duplicate")) return 7;
  if (!check(raw("quiescent", second, 4), "refused", "duplicate")) return 8;
  if (!check(raw("quiescent", "44444444444444444444444444444444", 5), "quiescent", "ok")) return 9;
  if (!check(raw("dispatch", "55555555555555555555555555555555", 6, "1", 1, 1), "refused", "cancelled")) return 10;
  if (parse(raw("quiescent", first, 7) + " ", frame) != Parse::valid) return 11;
  if (parse(raw("quiescent", first, 7).substr(0, 1) + "\"x\":1,", frame) != Parse::malformed) return 12;
  if (parse(raw("quiescent", first, 7).substr(0, 30), frame) != Parse::malformed) return 13;
  std::string trailing = raw("quiescent", first, 7);
  trailing.insert(trailing.size() - 1, ",");
  if (parse(trailing, frame) != Parse::malformed) return 14;
  std::string version = raw("quiescent", first, 7);
  version.replace(5, 1, "1");
  if (parse(version, frame) != Parse::version) return 15;
  if (parse(raw("dispatch", second, 1, "1", 1, 1), frame) != Parse::valid) return 16;
  const std::vector<INPUT> move = events(frame);
  if (move.size() != 1 || move[0].type != INPUT_MOUSE ||
      !(move[0].mi.dwFlags & MOUSEEVENTF_VIRTUALDESK)) return 17;
  Broker interrupted(partial, allowed, allowed);
  if (interrupted.handle(Frame{.type="hello", .session=first, .request=second, .nonce=third, .window="0"}).type != "ready") return 18;
  frame.request = "44444444444444444444444444444444";
  const Reply broken = interrupted.handle(frame);
  if (broken.type != "refused" || broken.code != "input_failed" || broken.accepted != 0 || broken.attempted != 1) return 19;
  Broker uncertain(partial, allowed, allowed);
  if (uncertain.handle(Frame{.type="hello", .session=first, .request=second, .nonce=third, .window="0"}).type != "ready") return 20;
  frame.action = "click";
  const Reply unknown = uncertain.handle(frame);
  if (unknown.type != "unknown" || unknown.code != "partial" || unknown.accepted != 2 || unknown.attempted != 3) return 21;
  frame.request = "55555555555555555555555555555555";
  frame.sequence = 2;
  frame.scene = 2;
  if (uncertain.handle(frame).code != "unknown") return 22;
  frame.type = "quiescent";
  frame.request = "88888888888888888888888888888888";
  frame.sequence = 3;
  frame.window = "0";
  frame.pid = 0;
  frame.scene = 0;
  if (uncertain.handle(frame).type != "unknown") return 31;
  frame.type = "dispatch";
  frame.window = "1";
  frame.pid = 1;
  Broker denied(rejected, allowed, allowed);
  if (denied.handle(Frame{.type="hello", .session=first, .request=second, .nonce=third, .window="0"}).type != "ready") return 23;
  frame.request = "66666666666666666666666666666666";
  frame.sequence = 1;
  frame.scene = 1;
  const Reply zero = denied.handle(frame);
  if (zero.code != "input_failed" || zero.accepted != 0 || zero.attempted != 3) return 24;
  frame.action = "double_click";
  if (!valid(frame) || events(frame).size() != 5) return 25;
  frame.action = "drag";
  frame.args = {0, 0, 1000000, 1000000, 0};
  if (!valid(frame) || events(frame).size() != 4) return 26;
  frame.action = "scroll";
  frame.args = {-120, 120, 0, 0, 0};
  if (!valid(frame) || events(frame).size() != 2) return 27;
  frame.action = "chord";
  frame.args = {static_cast<int64_t>('C'), 3, 0, 0, 0};
  if (!valid(frame) || events(frame).size() != 6) return 28;
  frame.action = "text";
  frame.args = {};
  frame.text = u"A\u00E9";
  if (!valid(frame) || events(frame).size() != 4) return 29;
  std::string malformed = raw("dispatch", "77777777777777777777777777777777", 1, "1", 1, 1);
  malformed.insert(malformed.size() - 1, ",\"surprise\":1");
  if (parse(malformed, frame) != Parse::malformed) return 30;
  Broker preempted(counting, blocking, allowed);
  if (preempted.handle(Frame{.type="hello", .session=first, .request=second,
                             .nonce=third, .window="0"}).type != "ready") return 32;
  Frame pending;
  if (parse(raw("dispatch", "99999999999999999999999999999999", 1, "1", 1, 1), pending) != Parse::valid)
    return 33;
  Reply stopped;
  std::thread action([&] { stopped = preempted.handle(pending); });
  {
    std::unique_lock<std::mutex> lock(test_mutex);
    test_ready.wait(lock, [] { return test_entered; });
  }
  Frame halt;
  if (parse(raw("cancel", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 2), halt) != Parse::valid ||
      preempted.handle(halt).type != "cancelled") {
    { std::lock_guard<std::mutex> lock(test_mutex); test_released = true; }
    test_ready.notify_all();
    action.join();
    return 34;
  }
  Frame later;
  if (parse(raw("dispatch", "cccccccccccccccccccccccccccccccc", 3, "1", 1, 2), later) != Parse::valid ||
      preempted.handle(later).code != "cancelled") {
    { std::lock_guard<std::mutex> lock(test_mutex); test_released = true; }
    test_ready.notify_all();
    action.join();
    return 37;
  }
  Frame quiet;
  if (parse(raw("quiescent", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 4), quiet) != Parse::valid) {
    { std::lock_guard<std::mutex> lock(test_mutex); test_released = true; }
    test_ready.notify_all();
    action.join();
    return 35;
  }
  Reply settled;
  std::thread receipt([&] { settled = preempted.handle(quiet); });
  {
    std::lock_guard<std::mutex> lock(test_mutex);
    test_released = true;
  }
  test_ready.notify_all();
  action.join();
  receipt.join();
  if (stopped.type != "refused" || stopped.code != "cancelled" ||
      settled.type != "quiescent" || test_sent != 0) return 36;
  const auto committed_case = [&](bool partial) {
    {
      std::lock_guard<std::mutex> lock(test_mutex);
      test_sender_entered = false;
      test_sender_released = false;
      test_waiting = false;
      test_partial = partial;
    }
    test_sent = 0;
    Broker committed(waiting_sender, allowed, allowed, now, waiting);
    if (committed.handle(Frame{.type="hello", .session=first, .request=second,
                                .nonce=third, .window="0"}).type != "ready") return false;
    Frame effect;
    if (parse(raw("dispatch", "99999999999999999999999999999999", 1, "1", 1, 1), effect) != Parse::valid)
      return false;
    effect.action = "click";
    Reply result;
    std::thread dispatch([&] { result = committed.handle(effect); });
    {
      std::unique_lock<std::mutex> lock(test_mutex);
      test_ready.wait(lock, [] { return test_sender_entered; });
    }
    Frame stop;
    Frame receipt_frame;
    const bool parsed = parse(raw("cancel", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 2), stop) == Parse::valid &&
      parse(raw("quiescent", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 3), receipt_frame) == Parse::valid;
    if (!parsed) {
      { std::lock_guard<std::mutex> lock(test_mutex); test_sender_released = true; }
      test_ready.notify_all();
      dispatch.join();
      return false;
    }
    const bool cancelled_reply = parsed && committed.handle(stop).type == "cancelled";
    Reply receipt_reply;
    std::atomic<bool> receipt_done = false;
    std::thread receipt_thread([&] {
      receipt_reply = committed.handle(receipt_frame);
      receipt_done.store(true, std::memory_order_release);
    });
    bool waited = false;
    {
      std::unique_lock<std::mutex> lock(test_mutex);
      test_ready.wait(lock, [] { return test_waiting; });
      waited = !receipt_done.load(std::memory_order_acquire);
      test_sender_released = true;
    }
    test_ready.notify_all();
    dispatch.join();
    receipt_thread.join();
    return cancelled_reply && waited && test_sent == 1 &&
      (partial ? result.type == "unknown" && result.code == "partial" &&
                   result.accepted == 2 && result.attempted == 3 &&
                   receipt_reply.type == "unknown" && receipt_reply.code == "partial"
               : result.type == "confirmed" && result.accepted == 3 &&
                   receipt_reply.type == "quiescent");
  };
  if (!committed_case(false)) return 38;
  if (!committed_case(true)) return 39;
  std::puts("desktop input broker self-test passed");
  return 0;
}
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--self-test") return selftest();
  if (argc != 1) return 2;
  if (!SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return 10;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE || !output || output == INVALID_HANDLE_VALUE) return 3;
  Broker broker;
  std::mutex queued_mutex;
  std::condition_variable ready;
  std::mutex output_mutex;
  std::deque<Frame> queued;
  bool ending = false;
  const auto respond = [&](const Reply& reply) {
    std::lock_guard<std::mutex> lock(output_mutex);
    return send(output, reply);
  };
  std::thread worker([&] {
    for (;;) {
      Frame frame;
      {
        std::unique_lock<std::mutex> lock(queued_mutex);
        ready.wait(lock, [&] { return ending || !queued.empty(); });
        if (queued.empty()) return;
        frame = std::move(queued.front());
        queued.pop_front();
      }
      if (!respond(broker.handle(frame))) {
        broker.stop();
        // The reader may be blocked on stdin while its output pipe is gone.
        // A dispatch receipt cannot be delivered, so terminate without replay.
        TerminateProcess(GetCurrentProcess(), 9);
        return;
      }
    }
  });
  const auto finish = [&](int code) {
    broker.stop();
    {
      std::lock_guard<std::mutex> lock(queued_mutex);
      ending = true;
    }
    ready.notify_one();
    worker.join();
    return code;
  };
  for (;;) {
    uint32_t length = 0;
    bool eof = false;
    if (!read(input, &length, sizeof(length), eof)) return finish(eof ? 0 : 4);
    if (!length || length > kHeader) {
      std::fprintf(stderr, "invalid native input frame length %u\n", length);
      return finish(5);
    }
    std::string header(length, '\0');
    if (!read(input, header.data(), length, eof)) return finish(6);
    uint32_t payload = 0;
    if (!read(input, &payload, sizeof(payload), eof) || payload > 512) return finish(7);
    std::string data(payload, '\0');
    if (payload && !read(input, data.data(), payload, eof)) return finish(7);
    Frame frame;
    const Parse parsed = parse(header, frame);
    if (parsed != Parse::valid) {
      const char* code = parsed == Parse::version ? "bad_version" : "bad_frame";
      if (!respond(Reply{"refused", std::string(kZero), std::string(kZero), 0, code})) return finish(8);
      continue;
    }
    if (frame.type == "dispatch" && frame.action == "text") {
      if (!payload || payload % 2) return finish(7);
      for (size_t i = 0; i < data.size(); i += 2)
        frame.text.push_back(static_cast<char16_t>(static_cast<unsigned char>(data[i]) |
          (static_cast<unsigned char>(data[i + 1]) << 8)));
      for (size_t i = 0; i < frame.text.size(); ++i) {
        const char16_t c = frame.text[i];
        if (!c) return finish(7);
        if (c >= 0xD800 && c <= 0xDBFF) {
          if (++i >= frame.text.size() || frame.text[i] < 0xDC00 || frame.text[i] > 0xDFFF) return finish(7);
        } else if (c >= 0xDC00 && c <= 0xDFFF) return finish(7);
      }
    } else if (payload) return finish(7);
    if (frame.type == "hello" || frame.type == "cancel") {
      if (!respond(broker.handle(frame))) return finish(9);
      continue;
    }
    bool accepted = false;
    {
      std::lock_guard<std::mutex> lock(queued_mutex);
      if (queued.size() < 16) {
        queued.push_back(std::move(frame));
        accepted = true;
      }
    }
    if (accepted) {
      ready.notify_one();
      continue;
    }
    if (!respond(Reply{"refused", frame.session, frame.request, frame.sequence, "input_busy"})) return finish(9);
  }
}
