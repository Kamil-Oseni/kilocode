// Raya's isolated Windows input broker protocol foundation. No input is injected here.
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
constexpr uint32_t kHeader = 4096;
constexpr size_t kHistory = 1024;
constexpr std::string_view kZero = "00000000000000000000000000000000";

struct Frame {
  std::string type;
  std::string session;
  std::string request;
  std::string nonce;
  std::string window;
  uint64_t sequence = 0;
  uint64_t scene = 0;
  uint32_t pid = 0;
};

struct Reply {
  std::string type;
  std::string session;
  std::string request;
  uint64_t sequence = 0;
  std::string code;
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
  if (pos != input.size() || values.size() != 9) return Parse::malformed;
  static constexpr std::array<std::string_view, 9> keys = {
    "v", "type", "session", "request", "sequence", "nonce", "windowID", "pid", "scene"
  };
  for (auto key : keys) if (!values.contains(std::string(key))) return Parse::malformed;
  if (!values["v"].empty() && values["v"][0] == '"') return Parse::malformed;
  if (values["v"] != "1") return Parse::version;
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
  uintptr_t target = 0;
  return id(frame.session) && id(frame.request) && id(frame.nonce) &&
    frame.session != kZero && frame.request != kZero && frame.nonce != kZero &&
    window(frame.window, target) ? Parse::valid : Parse::malformed;
}

std::string json(const Reply& reply) {
  return "{\"v\":1,\"type\":\"" + reply.type + "\",\"session\":\"" + reply.session +
    "\",\"request\":\"" + reply.request + "\",\"sequence\":" +
    std::to_string(reply.sequence) + ",\"code\":\"" + reply.code + "\"}";
}

bool exact(const Frame& frame) {
  uintptr_t value = 0;
  if (!window(frame.window, value) || !value) return false;
  const HWND target = reinterpret_cast<HWND>(value);
  if (!IsWindow(target)) return false;
  DWORD pid = 0;
  if (!GetWindowThreadProcessId(target, &pid) || pid != frame.pid) return false;
  return GetForegroundWindow() == target;
}

class Broker {
public:
  Reply handle(const Frame& frame) {
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
      cancelled = true;
      return reply("cancelled", "ok");
    }
    if (frame.type == "quiescent") return reply("quiescent", "ok");
    if (cancelled) return reply("refused", "cancelled");
    if (!frame.pid || !frame.scene || frame.window == "0") return reply("refused", "bad_target");
    if (!exact(frame)) return reply("refused", "changed_target");
    return reply("refused", "unsupported");
  }
private:
  bool bound = false;
  bool cancelled = false;
  uint64_t sequence = 0;
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

int selftest() {
  const std::string first = "11111111111111111111111111111111";
  const std::string second = "22222222222222222222222222222222";
  const std::string third = "33333333333333333333333333333333";
  const auto raw = [&](std::string type, std::string request, uint64_t sequence,
                       std::string target = "0", uint32_t pid = 0, uint64_t scene = 0) {
    return "{\"v\":1,\"type\":\"" + type + "\",\"session\":\"" + first +
      "\",\"request\":\"" + request + "\",\"sequence\":" + std::to_string(sequence) +
      ",\"nonce\":\"" + third + "\",\"windowID\":\"" + target +
      "\",\"pid\":" + std::to_string(pid) + ",\"scene\":" + std::to_string(scene) + "}";
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
  version.replace(5, 1, "2");
  if (parse(version, frame) != Parse::version) return 15;
  std::puts("desktop input broker self-test passed");
  return 0;
}
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--self-test") return selftest();
  if (argc != 1) return 2;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE || !output || output == INVALID_HANDLE_VALUE) return 3;
  Broker broker;
  for (;;) {
    uint32_t length = 0;
    bool eof = false;
    if (!read(input, &length, sizeof(length), eof)) return eof ? 0 : 4;
    if (!length || length > kHeader) return 5;
    std::string header(length, '\0');
    if (!read(input, header.data(), length, eof)) return 6;
    uint32_t payload = 0;
    if (!read(input, &payload, sizeof(payload), eof) || payload) return 7;
    Frame frame;
    const Parse parsed = parse(header, frame);
    if (parsed != Parse::valid) {
      const char* code = parsed == Parse::version ? "bad_version" : "bad_frame";
      if (!send(output, Reply{"refused", std::string(kZero), std::string(kZero), 0, code})) return 8;
      continue;
    }
    if (!send(output, broker.handle(frame))) return 9;
  }
}
