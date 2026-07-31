#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <functional>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "ltc_generator.h"

using Microsoft::WRL::ComPtr;

namespace {

std::mutex g_output_mutex;

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }
  const int required = WideCharToMultiByte(CP_UTF8, 0, value.data(),
                                           static_cast<int>(value.size()),
                                           nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return {};
  }
  std::string result(static_cast<std::size_t>(required), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                      result.data(), required, nullptr, nullptr);
  return result;
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return {};
  }
  const int required = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (required <= 0) {
    throw std::runtime_error("invalid UTF-8 string");
  }
  std::wstring result(static_cast<std::size_t>(required), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(),
                          required) <= 0) {
    throw std::runtime_error("invalid UTF-8 string");
  }
  return result;
}

std::string JsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"':
        output << "\\\"";
        break;
      case '\\':
        output << "\\\\";
        break;
      case '\b':
        output << "\\b";
        break;
      case '\f':
        output << "\\f";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (ch < 0x20) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<int>(ch) << std::dec;
        } else {
          output << static_cast<char>(ch);
        }
    }
  }
  return output.str();
}

void EmitJson(const std::string& json) {
  std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << json << '\n' << std::flush;
}

void EmitError(std::uint64_t generation, const std::string& message) {
  EmitJson("{\"event\":\"error\",\"generation\":" +
           std::to_string(generation) + ",\"message\":\"" +
           JsonEscape(message) + "\"}");
}

std::string HResultError(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " failed (HRESULT 0x" << std::hex << std::uppercase
          << static_cast<std::uint32_t>(result) << ')';
  return message.str();
}

void ThrowIfFailed(HRESULT result, const char* operation) {
  if (FAILED(result)) {
    throw std::runtime_error(HResultError(operation, result));
  }
}

void AppendUtf8(std::string& output, std::uint32_t code_point) {
  if (code_point <= 0x7F) {
    output.push_back(static_cast<char>(code_point));
  } else if (code_point <= 0x7FF) {
    output.push_back(static_cast<char>(0xC0 | (code_point >> 6)));
    output.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  } else if (code_point <= 0xFFFF) {
    output.push_back(static_cast<char>(0xE0 | (code_point >> 12)));
    output.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
    output.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  } else {
    output.push_back(static_cast<char>(0xF0 | (code_point >> 18)));
    output.push_back(static_cast<char>(0x80 | ((code_point >> 12) & 0x3F)));
    output.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
    output.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  }
}

enum class JsonType { kString, kNumber, kBoolean, kNull };

struct JsonValue {
  JsonType type = JsonType::kNull;
  std::string text;
};

using JsonObject = std::unordered_map<std::string, JsonValue>;

class JsonParser {
 public:
  explicit JsonParser(const std::string& input) : input_(input) {}

  bool Parse(JsonObject& output, std::string& error) {
    SkipWhitespace();
    if (!Consume('{')) {
      error = "NDJSON command must be a JSON object";
      return false;
    }
    SkipWhitespace();
    if (Consume('}')) {
      return Finish(error);
    }

    while (position_ < input_.size()) {
      std::string key;
      if (!ParseString(key, error)) {
        return false;
      }
      SkipWhitespace();
      if (!Consume(':')) {
        error = "expected ':' after JSON field name";
        return false;
      }
      SkipWhitespace();
      JsonValue value;
      if (!ParseValue(value, error)) {
        return false;
      }
      if (!output.emplace(std::move(key), std::move(value)).second) {
        error = "duplicate JSON field";
        return false;
      }
      SkipWhitespace();
      if (Consume('}')) {
        return Finish(error);
      }
      if (!Consume(',')) {
        error = "expected ',' or '}' in JSON object";
        return false;
      }
      SkipWhitespace();
    }
    error = "unterminated JSON object";
    return false;
  }

 private:
  bool Finish(std::string& error) {
    SkipWhitespace();
    if (position_ != input_.size()) {
      error = "unexpected data after JSON object";
      return false;
    }
    return true;
  }

  void SkipWhitespace() {
    while (position_ < input_.size() &&
           (input_[position_] == ' ' || input_[position_] == '\t' ||
            input_[position_] == '\r' || input_[position_] == '\n')) {
      ++position_;
    }
  }

  bool Consume(char expected) {
    if (position_ >= input_.size() || input_[position_] != expected) {
      return false;
    }
    ++position_;
    return true;
  }

  bool ParseValue(JsonValue& value, std::string& error) {
    if (position_ >= input_.size()) {
      error = "missing JSON value";
      return false;
    }
    if (input_[position_] == '"') {
      value.type = JsonType::kString;
      return ParseString(value.text, error);
    }
    if (input_[position_] == '-' ||
        (input_[position_] >= '0' && input_[position_] <= '9')) {
      value.type = JsonType::kNumber;
      return ParseNumber(value.text, error);
    }
    if (MatchLiteral("true")) {
      value.type = JsonType::kBoolean;
      value.text = "true";
      return true;
    }
    if (MatchLiteral("false")) {
      value.type = JsonType::kBoolean;
      value.text = "false";
      return true;
    }
    if (MatchLiteral("null")) {
      value.type = JsonType::kNull;
      value.text = "null";
      return true;
    }
    error = "unsupported or invalid JSON value";
    return false;
  }

  bool MatchLiteral(const char* literal) {
    const std::size_t length = std::char_traits<char>::length(literal);
    if (input_.compare(position_, length, literal) != 0) {
      return false;
    }
    position_ += length;
    return true;
  }

  bool ParseString(std::string& output, std::string& error) {
    if (!Consume('"')) {
      error = "expected JSON string";
      return false;
    }
    while (position_ < input_.size()) {
      const unsigned char ch =
          static_cast<unsigned char>(input_[position_++]);
      if (ch == '"') {
        return true;
      }
      if (ch < 0x20) {
        error = "unescaped control character in JSON string";
        return false;
      }
      if (ch != '\\') {
        output.push_back(static_cast<char>(ch));
        continue;
      }
      if (position_ >= input_.size()) {
        error = "unterminated JSON escape";
        return false;
      }
      const char escaped = input_[position_++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          output.push_back(escaped);
          break;
        case 'b':
          output.push_back('\b');
          break;
        case 'f':
          output.push_back('\f');
          break;
        case 'n':
          output.push_back('\n');
          break;
        case 'r':
          output.push_back('\r');
          break;
        case 't':
          output.push_back('\t');
          break;
        case 'u': {
          std::uint32_t code_point = 0;
          if (!ParseHex4(code_point)) {
            error = "invalid JSON Unicode escape";
            return false;
          }
          if (code_point >= 0xD800 && code_point <= 0xDBFF) {
            if (position_ + 2 > input_.size() || input_[position_] != '\\' ||
                input_[position_ + 1] != 'u') {
              error = "missing low surrogate in JSON Unicode escape";
              return false;
            }
            position_ += 2;
            std::uint32_t low = 0;
            if (!ParseHex4(low) || low < 0xDC00 || low > 0xDFFF) {
              error = "invalid low surrogate in JSON Unicode escape";
              return false;
            }
            code_point =
                0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00);
          } else if (code_point >= 0xDC00 && code_point <= 0xDFFF) {
            error = "unexpected low surrogate in JSON Unicode escape";
            return false;
          }
          AppendUtf8(output, code_point);
          break;
        }
        default:
          error = "invalid JSON string escape";
          return false;
      }
    }
    error = "unterminated JSON string";
    return false;
  }

  bool ParseHex4(std::uint32_t& value) {
    if (position_ + 4 > input_.size()) {
      return false;
    }
    value = 0;
    for (int index = 0; index < 4; ++index) {
      const char ch = input_[position_++];
      value <<= 4;
      if (ch >= '0' && ch <= '9') {
        value += static_cast<std::uint32_t>(ch - '0');
      } else if (ch >= 'a' && ch <= 'f') {
        value += static_cast<std::uint32_t>(10 + ch - 'a');
      } else if (ch >= 'A' && ch <= 'F') {
        value += static_cast<std::uint32_t>(10 + ch - 'A');
      } else {
        return false;
      }
    }
    return true;
  }

  bool ParseNumber(std::string& output, std::string& error) {
    const std::size_t start = position_;
    if (Consume('-') && position_ >= input_.size()) {
      error = "invalid JSON number";
      return false;
    }
    if (position_ < input_.size() && input_[position_] == '0') {
      ++position_;
    } else {
      const std::size_t digits = position_;
      while (position_ < input_.size() && input_[position_] >= '0' &&
             input_[position_] <= '9') {
        ++position_;
      }
      if (digits == position_) {
        error = "invalid JSON number";
        return false;
      }
    }
    if (Consume('.')) {
      const std::size_t digits = position_;
      while (position_ < input_.size() && input_[position_] >= '0' &&
             input_[position_] <= '9') {
        ++position_;
      }
      if (digits == position_) {
        error = "invalid JSON number fraction";
        return false;
      }
    }
    if (position_ < input_.size() &&
        (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() &&
          (input_[position_] == '+' || input_[position_] == '-')) {
        ++position_;
      }
      const std::size_t digits = position_;
      while (position_ < input_.size() && input_[position_] >= '0' &&
             input_[position_] <= '9') {
        ++position_;
      }
      if (digits == position_) {
        error = "invalid JSON number exponent";
        return false;
      }
    }
    output = input_.substr(start, position_ - start);
    return true;
  }

  const std::string& input_;
  std::size_t position_ = 0;
};

const JsonValue* FindField(const JsonObject& object, const char* name) {
  const auto found = object.find(name);
  return found == object.end() ? nullptr : &found->second;
}

bool ReadString(const JsonObject& object, const char* name, std::string& value,
                bool required, std::string& error) {
  const JsonValue* field = FindField(object, name);
  if (!field) {
    if (required) {
      error = std::string("missing string field '") + name + "'";
      return false;
    }
    return true;
  }
  if (field->type != JsonType::kString) {
    error = std::string("field '") + name + "' must be a string";
    return false;
  }
  value = field->text;
  return true;
}

bool ParseUint64(const JsonValue& field, std::uint64_t& value) {
  if (field.type != JsonType::kNumber || field.text.empty()) {
    return false;
  }
  const char* begin = field.text.data();
  const char* end = begin + field.text.size();
  const auto result = std::from_chars(begin, end, value);
  return result.ec == std::errc{} && result.ptr == end;
}

bool ReadUint64(const JsonObject& object, const char* name,
                std::uint64_t& value, bool required, std::string& error) {
  const JsonValue* field = FindField(object, name);
  if (!field) {
    if (required) {
      error = std::string("missing integer field '") + name + "'";
      return false;
    }
    return true;
  }
  if (!ParseUint64(*field, value)) {
    error = std::string("field '") + name +
            "' must be a non-negative integer";
    return false;
  }
  return true;
}

bool ParseDouble(const JsonValue& field, double& value) {
  if (field.type != JsonType::kNumber) {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  value = std::strtod(field.text.c_str(), &end);
  return errno != ERANGE && end == field.text.c_str() + field.text.size() &&
         std::isfinite(value);
}

bool ReadDouble(const JsonObject& object, const char* name, double& value,
                bool required, std::string& error) {
  const JsonValue* field = FindField(object, name);
  if (!field) {
    if (required) {
      error = std::string("missing number field '") + name + "'";
      return false;
    }
    return true;
  }
  if (!ParseDouble(*field, value)) {
    error = std::string("field '") + name + "' must be a finite number";
    return false;
  }
  return true;
}

bool ReadInt(const JsonObject& object, const char* name, int& value,
             bool required, std::string& error) {
  const JsonValue* field = FindField(object, name);
  if (!field) {
    if (required) {
      error = std::string("missing integer field '") + name + "'";
      return false;
    }
    return true;
  }
  if (field->type != JsonType::kNumber) {
    error = std::string("field '") + name + "' must be an integer";
    return false;
  }
  const char* begin = field->text.data();
  const char* end = begin + field->text.size();
  const auto result = std::from_chars(begin, end, value);
  if (result.ec != std::errc{} || result.ptr != end) {
    error = std::string("field '") + name + "' must be an integer";
    return false;
  }
  return true;
}

enum class CommandKind { kStart, kSync, kHold, kStop, kShutdown };

struct Command {
  CommandKind kind = CommandKind::kHold;
  std::uint64_t generation = 0;
  std::string source_key;
  double elapsed_ms = 0.0;
  double rate = 1.0;
  double amplitude = 0.55;
  int fps = 25;
  int sample_rate = prodjlink::kSampleRate;
  int channels = prodjlink::kChannels;
  int bits_per_sample = prodjlink::kBitsPerSample;
  std::wstring endpoint_id;
  std::chrono::steady_clock::time_point received_at =
      std::chrono::steady_clock::now();
};

struct SharedState {
  std::mutex mutex;
  std::deque<Command> commands;
  std::uint64_t highest_generation = 0;
  std::uint64_t applied_generation = 0;
  std::string latest_source_key;
  int latest_fps = 25;
  bool accepting_commands = true;
  HANDLE control_event = nullptr;
};

std::uint64_t HighestGeneration(SharedState& shared) {
  std::lock_guard<std::mutex> lock(shared.mutex);
  return shared.highest_generation;
}

std::uint64_t AppliedGeneration(SharedState& shared) {
  std::lock_guard<std::mutex> lock(shared.mutex);
  return shared.applied_generation;
}

int LatestFps(SharedState& shared) {
  std::lock_guard<std::mutex> lock(shared.mutex);
  return shared.latest_fps;
}

void SetAppliedGeneration(SharedState& shared, std::uint64_t generation) {
  std::lock_guard<std::mutex> lock(shared.mutex);
  shared.applied_generation = generation;
}

bool EnqueueCommand(SharedState& shared, Command command,
                    bool reject_if_stale) {
  std::uint64_t current_generation = 0;
  {
    std::lock_guard<std::mutex> lock(shared.mutex);
    if (!shared.accepting_commands) {
      return false;
    }
    current_generation = shared.highest_generation;
    if (reject_if_stale && command.generation < current_generation) {
      // Emit outside the state lock.
    } else {
      shared.highest_generation =
          std::max(shared.highest_generation, command.generation);
      if (!command.source_key.empty()) {
        shared.latest_source_key = command.source_key;
      } else {
        command.source_key = shared.latest_source_key;
      }
      if (command.kind == CommandKind::kStart ||
          command.kind == CommandKind::kSync) {
        shared.latest_fps = command.fps;
      }
      if (command.kind == CommandKind::kShutdown) {
        shared.accepting_commands = false;
      }
      shared.commands.push_back(std::move(command));
      SetEvent(shared.control_event);
      return true;
    }
  }
  EmitError(command.generation,
            "stale generation ignored; current generation is " +
                std::to_string(current_generation));
  return true;
}

void EnqueueInternalShutdown(SharedState& shared) {
  Command command;
  command.kind = CommandKind::kShutdown;
  {
    std::lock_guard<std::mutex> lock(shared.mutex);
    if (!shared.accepting_commands) {
      return;
    }
    command.generation = shared.highest_generation;
    command.source_key = shared.latest_source_key;
    shared.accepting_commands = false;
    shared.commands.push_back(std::move(command));
  }
  SetEvent(shared.control_event);
}

std::vector<Command> TakeCommands(SharedState& shared) {
  std::vector<Command> commands;
  std::lock_guard<std::mutex> lock(shared.mutex);
  commands.reserve(shared.commands.size());
  while (!shared.commands.empty()) {
    commands.push_back(std::move(shared.commands.front()));
    shared.commands.pop_front();
  }
  return commands;
}

bool ProcessCommandLine(const std::string& line, SharedState& shared,
                        int default_fps) {
  if (line.empty()) {
    return true;
  }

  JsonObject object;
  std::string error;
  if (!JsonParser(line).Parse(object, error)) {
    EmitError(HighestGeneration(shared), error);
    return true;
  }

  std::uint64_t error_generation = HighestGeneration(shared);
  if (const JsonValue* generation = FindField(object, "generation")) {
    std::uint64_t parsed = 0;
    if (ParseUint64(*generation, parsed)) {
      error_generation = parsed;
    }
  }

  std::string command_name;
  const char* command_field = FindField(object, "command") ? "command" : "cmd";
  if (!ReadString(object, command_field, command_name, true, error)) {
    EmitError(error_generation, error);
    return true;
  }

  Command command;
  command.fps = LatestFps(shared);
  if (!prodjlink::IsSupportedFps(command.fps)) {
    command.fps = default_fps;
  }
  command.received_at = std::chrono::steady_clock::now();

  if (command_name == "start") {
    command.kind = CommandKind::kStart;
  } else if (command_name == "sync") {
    command.kind = CommandKind::kSync;
  } else if (command_name == "hold") {
    command.kind = CommandKind::kHold;
  } else if (command_name == "stop") {
    command.kind = CommandKind::kStop;
  } else if (command_name == "shutdown") {
    command.kind = CommandKind::kShutdown;
  } else {
    EmitError(error_generation, "unsupported command '" + command_name + "'");
    return true;
  }

  const bool is_shutdown = command.kind == CommandKind::kShutdown;
  if (!ReadUint64(object, "generation", command.generation, !is_shutdown,
                  error)) {
    EmitError(error_generation, error);
    return true;
  }
  if (is_shutdown && !FindField(object, "generation")) {
    command.generation = HighestGeneration(shared);
  }
  if (!ReadString(object, "sourceKey", command.source_key,
                  command.kind == CommandKind::kSync, error)) {
    EmitError(command.generation, error);
    return true;
  }

  if (command.kind == CommandKind::kStart) {
    std::string endpoint_id;
    if (!ReadString(object, "endpointId", endpoint_id, true, error) ||
        !ReadInt(object, "fps", command.fps, false, error) ||
        !ReadInt(object, "sampleRate", command.sample_rate, false, error) ||
        !ReadInt(object, "channels", command.channels, false, error) ||
        !ReadInt(object, "bitsPerSample", command.bits_per_sample, false,
                 error) ||
        !ReadDouble(object, "amplitude", command.amplitude, false, error)) {
      EmitError(command.generation, error);
      return true;
    }
    if (endpoint_id.empty()) {
      EmitError(command.generation, "field 'endpointId' must not be empty");
      return true;
    }
    if (!prodjlink::IsSupportedFps(command.fps)) {
      EmitError(command.generation, "field 'fps' must be 24, 25, or 30");
      return true;
    }
    if (command.sample_rate != prodjlink::kSampleRate ||
        command.channels != prodjlink::kChannels ||
        command.bits_per_sample != prodjlink::kBitsPerSample) {
      EmitError(command.generation,
                "start supports only 48000 Hz, 2 channels, 16-bit PCM");
      return true;
    }
    if (command.amplitude <= 0.0 || command.amplitude > 1.0) {
      EmitError(command.generation,
                "field 'amplitude' must be greater than 0 and at most 1");
      return true;
    }
    try {
      command.endpoint_id = Utf8ToWide(endpoint_id);
    } catch (const std::exception& exception) {
      EmitError(command.generation, exception.what());
      return true;
    }
  }

  if (command.kind == CommandKind::kSync) {
    if (command.source_key.empty()) {
      EmitError(command.generation, "field 'sourceKey' must not be empty");
      return true;
    }
    if (!ReadDouble(object, "elapsedMs", command.elapsed_ms, true, error) ||
        !ReadDouble(object, "rate", command.rate, false, error) ||
        !ReadInt(object, "fps", command.fps, false, error)) {
      EmitError(command.generation, error);
      return true;
    }
    if (command.elapsed_ms < 0.0) {
      EmitError(command.generation, "field 'elapsedMs' must be non-negative");
      return true;
    }
    if (command.rate < 0.25 || command.rate > 4.0) {
      EmitError(command.generation, "field 'rate' must be between 0.25 and 4.0");
      return true;
    }
    if (!prodjlink::IsSupportedFps(command.fps)) {
      EmitError(command.generation, "field 'fps' must be 24, 25, or 30");
      return true;
    }
  }

  const bool accepted =
      EnqueueCommand(shared, std::move(command), !is_shutdown);
  return accepted && !is_shutdown;
}

struct StartupState {
  std::mutex mutex;
  std::condition_variable condition;
  bool done = false;
  bool ok = false;
};

void CompleteStartup(StartupState& startup, bool ok) {
  {
    std::lock_guard<std::mutex> lock(startup.mutex);
    if (startup.done) {
      return;
    }
    startup.done = true;
    startup.ok = ok;
  }
  startup.condition.notify_one();
}

std::string DeviceFriendlyName(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  ThrowIfFailed(device->OpenPropertyStore(STGM_READ, &properties),
                "IMMDevice::OpenPropertyStore");
  PROPVARIANT value;
  PropVariantInit(&value);
  const HRESULT result =
      properties->GetValue(PKEY_Device_FriendlyName, &value);
  std::string name;
  if (SUCCEEDED(result) && value.vt == VT_LPWSTR && value.pwszVal) {
    name = WideToUtf8(value.pwszVal);
  }
  PropVariantClear(&value);
  ThrowIfFailed(result, "IPropertyStore::GetValue");
  return name;
}

std::wstring DeviceId(IMMDevice* device) {
  LPWSTR value = nullptr;
  ThrowIfFailed(device->GetId(&value), "IMMDevice::GetId");
  std::wstring id = value ? value : L"";
  CoTaskMemFree(value);
  return id;
}

class WasapiRenderer {
 public:
  WasapiRenderer(SharedState& shared, int default_fps)
      : shared_(shared),
        mapping_{0.0, 1.0, 0, default_fps},
        generator_(default_fps) {}

  void OpenEndpoint(const std::wstring& endpoint_id, int fps,
                    double amplitude) {
    CloseEndpoint();
    endpoint_id_ = endpoint_id;
    mapping_.fps = fps;
    mapping_.elapsed_ms = 0.0;
    mapping_.rate = 1.0;
    mapping_.anchor_sample = 0;
    generator_.SetAmplitude(amplitude);
    generator_.Reset(fps);
    mode_ = OutputMode::kSilent;
    total_frames_written_ = 0;

    ComPtr<IMMDeviceEnumerator> enumerator;
    ThrowIfFailed(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                   CLSCTX_ALL, IID_PPV_ARGS(&enumerator)),
                  "CoCreateInstance(MMDeviceEnumerator)");
    ThrowIfFailed(enumerator->GetDevice(endpoint_id_.c_str(), &device_),
                  "IMMDeviceEnumerator::GetDevice");

    DWORD state = 0;
    ThrowIfFailed(device_->GetState(&state), "IMMDevice::GetState");
    if ((state & DEVICE_STATE_ACTIVE) == 0) {
      throw std::runtime_error("selected render endpoint is not active");
    }
    endpoint_name_ = DeviceFriendlyName(device_.Get());

    ThrowIfFailed(device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL,
                                    nullptr,
                                    reinterpret_cast<void**>(
                                        audio_client_.GetAddressOf())),
                  "IMMDevice::Activate(IAudioClient)");

    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = prodjlink::kChannels;
    format.nSamplesPerSec = prodjlink::kSampleRate;
    format.wBitsPerSample = prodjlink::kBitsPerSample;
    format.nBlockAlign =
        format.nChannels * format.wBitsPerSample / static_cast<WORD>(8);
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    format.cbSize = 0;

    constexpr DWORD kStreamFlags =
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    ThrowIfFailed(audio_client_->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                             kStreamFlags, 0, 0, &format,
                                             nullptr),
                  "IAudioClient::Initialize");

    audio_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!audio_event_) {
      throw std::runtime_error("CreateEvent(audio) failed");
    }
    ThrowIfFailed(audio_client_->SetEventHandle(audio_event_),
                  "IAudioClient::SetEventHandle");
    ThrowIfFailed(audio_client_->GetBufferSize(&buffer_frames_),
                  "IAudioClient::GetBufferSize");
    ThrowIfFailed(audio_client_->GetService(IID_PPV_ARGS(&render_client_)),
                  "IAudioClient::GetService(IAudioRenderClient)");

    FillExact(buffer_frames_);
    ThrowIfFailed(audio_client_->Start(), "IAudioClient::Start");
  }

  ~WasapiRenderer() { CloseEndpoint(); }

  void CloseEndpoint() {
    if (audio_client_) {
      audio_client_->Stop();
    }
    if (audio_event_) {
      CloseHandle(audio_event_);
      audio_event_ = nullptr;
    }
    render_client_.Reset();
    audio_client_.Reset();
    device_.Reset();
    buffer_frames_ = 0;
    total_frames_written_ = 0;
    endpoint_id_.clear();
    endpoint_name_.clear();
  }

  const std::string& endpoint_name() const { return endpoint_name_; }
  const std::wstring& endpoint_id() const { return endpoint_id_; }

  bool Run() {
    while (true) {
      const std::array<HANDLE, 2> events = {shared_.control_event, audio_event_};
      const DWORD event_count = audio_event_ ? 2 : 1;
      const DWORD wait = WaitForMultipleObjects(
          event_count, events.data(), FALSE, INFINITE);
      if (wait == WAIT_FAILED) {
        throw std::runtime_error("WaitForMultipleObjects(audio) failed");
      }

      if (wait == WAIT_OBJECT_0) {
        for (const Command& command : TakeCommands(shared_)) {
          try {
            if (!Apply(command)) {
              return true;
            }
          } catch (const std::exception& exception) {
            EmitError(command.generation, exception.what());
            CloseEndpoint();
          }
        }
      }

      if (wait == WAIT_OBJECT_0 + 1 && audio_event_) {
        try {
          FillAvailable();
        } catch (const std::exception& exception) {
          EmitError(current_generation_, exception.what());
          CloseEndpoint();
        }
      }
    }
  }

 private:
  enum class OutputMode { kSilent, kPlaying };

  bool Apply(const Command& command) {
    current_generation_ = command.generation;
    SetAppliedGeneration(shared_, current_generation_);
    const std::string source_key = command.source_key.empty()
                                       ? current_source_key_
                                       : command.source_key;

    if (command.kind == CommandKind::kShutdown) {
      current_source_key_ = source_key;
      if (audio_client_) {
        ThrowIfFailed(audio_client_->Stop(), "IAudioClient::Stop(shutdown)");
      }
      return false;
    }

    if (command.kind == CommandKind::kStart) {
      current_source_key_ = source_key;
      OpenEndpoint(command.endpoint_id, command.fps, command.amplitude);
      EmitJson("{\"event\":\"started\",\"generation\":" +
               std::to_string(command.generation) +
               ",\"endpointId\":\"" + JsonEscape(WideToUtf8(endpoint_id_)) +
               "\",\"endpointName\":\"" + JsonEscape(endpoint_name_) +
               "\"}");
      return true;
    }

    if (command.kind == CommandKind::kHold ||
        command.kind == CommandKind::kStop) {
      current_source_key_ = source_key;
      mode_ = OutputMode::kSilent;
      if (audio_client_) {
        RestartStream();
      }
      EmitJson("{\"event\":\"held\",\"generation\":" +
               std::to_string(command.generation) +
               ",\"sourceKey\":\"" + JsonEscape(current_source_key_) +
               "\",\"command\":\"" +
               std::string(command.kind == CommandKind::kStop ? "stop"
                                                               : "hold") +
               "\"}");
      return true;
    }

    if (!audio_client_) {
      EmitError(command.generation,
                "audio endpoint is not started; send start first");
      return true;
    }

    const auto now = std::chrono::steady_clock::now();
    const double command_age_ms =
        std::chrono::duration<double, std::milli>(now - command.received_at)
            .count();
    const double adjusted_elapsed_ms =
        command.elapsed_ms + command_age_ms * command.rate;
    const bool restart = mode_ != OutputMode::kPlaying ||
                         mapping_.fps != command.fps ||
                         (!current_source_key_.empty() &&
                          current_source_key_ != source_key);

    current_source_key_ = source_key;
    mapping_.elapsed_ms = adjusted_elapsed_ms;
    mapping_.rate = command.rate;
    mapping_.fps = command.fps;

    if (restart) {
      mode_ = OutputMode::kPlaying;
      mapping_.anchor_sample = 0;
      generator_.Reset(mapping_.fps);
      RestartStream();
    } else {
      UINT32 padding = 0;
      ThrowIfFailed(audio_client_->GetCurrentPadding(&padding),
                    "IAudioClient::GetCurrentPadding(sync)");
      mapping_.anchor_sample =
          total_frames_written_ >= padding ? total_frames_written_ - padding
                                           : 0;
    }

    std::ostringstream event;
    event << "{\"event\":\"playing\",\"generation\":"
          << command.generation << ",\"sourceKey\":\""
          << JsonEscape(current_source_key_) << "\",\"elapsedMs\":"
          << std::fixed << std::setprecision(3) << adjusted_elapsed_ms
          << ",\"rate\":" << command.rate << ",\"fps\":" << command.fps
          << '}';
    EmitJson(event.str());
    return true;
  }

  void RestartStream() {
    ThrowIfFailed(audio_client_->Stop(), "IAudioClient::Stop(restart)");
    ThrowIfFailed(audio_client_->Reset(), "IAudioClient::Reset(restart)");
    total_frames_written_ = 0;
    generator_.Reset(mapping_.fps);
    FillExact(buffer_frames_);
    ThrowIfFailed(audio_client_->Start(), "IAudioClient::Start(restart)");
  }

  void FillAvailable() {
    UINT32 padding = 0;
    ThrowIfFailed(audio_client_->GetCurrentPadding(&padding),
                  "IAudioClient::GetCurrentPadding");
    if (padding < buffer_frames_) {
      FillExact(buffer_frames_ - padding);
    }
  }

  void FillExact(UINT32 frame_count) {
    if (frame_count == 0) {
      return;
    }
    BYTE* bytes = nullptr;
    ThrowIfFailed(render_client_->GetBuffer(frame_count, &bytes),
                  "IAudioRenderClient::GetBuffer");
    DWORD flags = 0;
    if (mode_ == OutputMode::kSilent) {
      flags = AUDCLNT_BUFFERFLAGS_SILENT;
    } else {
      generator_.Render(reinterpret_cast<std::int16_t*>(bytes), frame_count,
                        total_frames_written_, mapping_);
    }
    const HRESULT release = render_client_->ReleaseBuffer(frame_count, flags);
    ThrowIfFailed(release, "IAudioRenderClient::ReleaseBuffer");
    total_frames_written_ += frame_count;
  }

  std::wstring endpoint_id_;
  SharedState& shared_;
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> audio_client_;
  ComPtr<IAudioRenderClient> render_client_;
  HANDLE audio_event_ = nullptr;
  UINT32 buffer_frames_ = 0;
  std::uint64_t total_frames_written_ = 0;
  std::uint64_t current_generation_ = 0;
  std::string endpoint_name_;
  std::string current_source_key_;
  OutputMode mode_ = OutputMode::kSilent;
  prodjlink::LtcMapping mapping_;
  prodjlink::LtcGenerator generator_;
};

void AudioThread(const std::wstring& endpoint_id, SharedState& shared,
                 StartupState& startup, HANDLE audio_done, int default_fps) {
  bool com_initialized = false;
  try {
    ThrowIfFailed(CoInitializeEx(nullptr, COINIT_MULTITHREADED),
                  "CoInitializeEx(audio)");
    com_initialized = true;
    WasapiRenderer renderer(shared, default_fps);
    if (!endpoint_id.empty()) {
      renderer.OpenEndpoint(endpoint_id, default_fps, 0.55);
      EmitJson("{\"event\":\"started\",\"generation\":0,\"endpointId\":\"" +
               JsonEscape(WideToUtf8(endpoint_id)) +
               "\",\"endpointName\":\"" +
               JsonEscape(renderer.endpoint_name()) + "\"}");
    }
    CompleteStartup(startup, true);
    renderer.Run();
  } catch (const std::exception& exception) {
    bool was_started = false;
    {
      std::lock_guard<std::mutex> lock(startup.mutex);
      was_started = startup.done && startup.ok;
    }
    EmitError(was_started ? AppliedGeneration(shared) : 0, exception.what());
    CompleteStartup(startup, false);
  }
  if (com_initialized) {
    CoUninitialize();
  }
  SetEvent(audio_done);
}

struct DeviceInfo {
  std::string endpoint_id;
  std::string name;
  bool is_default = false;
};

int ListDevices() {
  bool com_initialized = false;
  try {
    ThrowIfFailed(CoInitializeEx(nullptr, COINIT_MULTITHREADED),
                  "CoInitializeEx(list-devices)");
    com_initialized = true;
    std::string json;
    {
      ComPtr<IMMDeviceEnumerator> enumerator;
      ThrowIfFailed(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                     CLSCTX_ALL, IID_PPV_ARGS(&enumerator)),
                    "CoCreateInstance(MMDeviceEnumerator)");

      std::wstring default_id;
      ComPtr<IMMDevice> default_device;
      if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(
              eRender, eConsole, &default_device))) {
        default_id = DeviceId(default_device.Get());
      }

      ComPtr<IMMDeviceCollection> collection;
      ThrowIfFailed(enumerator->EnumAudioEndpoints(
                        eRender, DEVICE_STATE_ACTIVE, &collection),
                    "IMMDeviceEnumerator::EnumAudioEndpoints");
      UINT count = 0;
      ThrowIfFailed(collection->GetCount(&count),
                    "IMMDeviceCollection::GetCount");

      std::vector<DeviceInfo> devices;
      devices.reserve(count);
      for (UINT index = 0; index < count; ++index) {
        ComPtr<IMMDevice> device;
        ThrowIfFailed(collection->Item(index, &device),
                      "IMMDeviceCollection::Item");
        const std::wstring id = DeviceId(device.Get());
        devices.push_back({WideToUtf8(id), DeviceFriendlyName(device.Get()),
                           id == default_id});
      }
      std::stable_sort(devices.begin(), devices.end(),
                       [](const DeviceInfo& left, const DeviceInfo& right) {
                         return left.is_default && !right.is_default;
                       });

      std::ostringstream output;
      output << "{\"devices\":[";
      for (std::size_t index = 0; index < devices.size(); ++index) {
        if (index != 0) {
          output << ',';
        }
        const DeviceInfo& device = devices[index];
        output << "{\"endpointId\":\"" << JsonEscape(device.endpoint_id)
               << "\",\"name\":\"" << JsonEscape(device.name)
               << "\",\"state\":\"active\",\"default\":"
               << (device.is_default ? "true" : "false") << '}';
      }
      output << "]}";
      json = output.str();
    }
    CoUninitialize();
    EmitJson(json);
    return 0;
  } catch (const std::exception& exception) {
    if (com_initialized) {
      CoUninitialize();
    }
    EmitJson("{\"devices\":[],\"error\":\"" +
             JsonEscape(exception.what()) + "\"}");
    return 1;
  }
}

struct Options {
  bool list_devices = false;
  bool help = false;
  std::wstring endpoint_id;
  int default_fps = 25;
};

bool ParseOptions(int argc, wchar_t** argv, Options& options,
                  std::string& error) {
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    if (argument == L"--list-devices") {
      options.list_devices = true;
    } else if (argument == L"--endpoint-id") {
      if (++index >= argc) {
        error = "--endpoint-id requires a value";
        return false;
      }
      options.endpoint_id = argv[index];
    } else if (argument == L"--fps") {
      if (++index >= argc) {
        error = "--fps requires a value";
        return false;
      }
      try {
        options.default_fps = std::stoi(argv[index]);
      } catch (...) {
        error = "--fps must be 24, 25, or 30";
        return false;
      }
      if (!prodjlink::IsSupportedFps(options.default_fps)) {
        error = "--fps must be 24, 25, or 30";
        return false;
      }
    } else if (argument == L"--help" || argument == L"-h") {
      options.help = true;
    } else {
      error = "unknown argument: " + WideToUtf8(argument);
      return false;
    }
  }
  return true;
}

bool DispatchInput(std::string& pending, const char* bytes, std::size_t count,
                   SharedState& shared, int default_fps) {
  constexpr std::size_t kMaxLineBytes = 64 * 1024;
  pending.append(bytes, count);
  if (pending.size() > kMaxLineBytes && pending.find('\n') == std::string::npos) {
    EmitError(HighestGeneration(shared), "NDJSON command exceeds 64 KiB");
    EnqueueInternalShutdown(shared);
    return false;
  }

  std::size_t newline = 0;
  while ((newline = pending.find('\n')) != std::string::npos) {
    if (newline > kMaxLineBytes) {
      EmitError(HighestGeneration(shared), "NDJSON command exceeds 64 KiB");
      EnqueueInternalShutdown(shared);
      return false;
    }
    std::string line = pending.substr(0, newline);
    pending.erase(0, newline + 1);
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    if (!ProcessCommandLine(line, shared, default_fps)) {
      return false;
    }
  }
  return true;
}

void InputLoop(SharedState& shared, HANDLE audio_done, int default_fps) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE) {
    EmitError(HighestGeneration(shared), "stdin is not available");
    EnqueueInternalShutdown(shared);
    return;
  }

  const DWORD file_type = GetFileType(input);
  std::string pending;
  std::array<char, 4096> buffer{};
  bool keep_reading = true;
  bool reached_eof = false;

  while (keep_reading &&
         WaitForSingleObject(audio_done, 0) != WAIT_OBJECT_0) {
    DWORD bytes_to_read = static_cast<DWORD>(buffer.size());
    if (file_type == FILE_TYPE_PIPE) {
      DWORD available = 0;
      if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) {
          reached_eof = true;
          break;
        }
        EmitError(HighestGeneration(shared), "PeekNamedPipe(stdin) failed");
        break;
      }
      if (available == 0) {
        if (WaitForSingleObject(audio_done, 20) == WAIT_OBJECT_0) {
          return;
        }
        continue;
      }
      bytes_to_read = std::min<DWORD>(available, bytes_to_read);
    } else if (file_type == FILE_TYPE_CHAR) {
      const std::array<HANDLE, 2> handles = {audio_done, input};
      const DWORD wait = WaitForMultipleObjects(
          static_cast<DWORD>(handles.size()), handles.data(), FALSE, 100);
      if (wait == WAIT_OBJECT_0) {
        return;
      }
      if (wait != WAIT_OBJECT_0 + 1) {
        continue;
      }
    }

    DWORD bytes_read = 0;
    if (!ReadFile(input, buffer.data(), bytes_to_read, &bytes_read, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) {
        reached_eof = true;
        break;
      }
      EmitError(HighestGeneration(shared), "ReadFile(stdin) failed");
      break;
    }
    if (bytes_read == 0) {
      reached_eof = true;
      break;
    }
    keep_reading = DispatchInput(pending, buffer.data(), bytes_read, shared,
                                 default_fps);
  }

  if (reached_eof && keep_reading && !pending.empty()) {
    if (!pending.empty() && pending.back() == '\r') {
      pending.pop_back();
    }
    keep_reading = ProcessCommandLine(pending, shared, default_fps);
  }
  if (keep_reading) {
    EnqueueInternalShutdown(shared);
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);

  Options options;
  std::string option_error;
  if (!ParseOptions(argc, argv, options, option_error)) {
    EmitError(0, option_error);
    return 2;
  }
  if (options.help) {
    std::cerr << "Usage:\n"
              << "  prodjlink-wasapi-ltc.exe --list-devices\n"
              << "  prodjlink-wasapi-ltc.exe --endpoint-id <id> [--fps 25]\n";
    return 0;
  }
  if (options.list_devices) {
    return ListDevices();
  }

  EmitJson("{\"event\":\"ready\"}");

  SharedState shared;
  shared.latest_fps = options.default_fps;
  shared.control_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE audio_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!shared.control_event || !audio_done) {
    EmitError(0, "CreateEvent failed");
    if (shared.control_event) {
      CloseHandle(shared.control_event);
    }
    if (audio_done) {
      CloseHandle(audio_done);
    }
    EmitJson("{\"event\":\"stopped\",\"generation\":0}");
    return 1;
  }

  StartupState startup;
  std::thread audio_thread(AudioThread, std::cref(options.endpoint_id),
                           std::ref(shared), std::ref(startup), audio_done,
                           options.default_fps);
  {
    std::unique_lock<std::mutex> lock(startup.mutex);
    startup.condition.wait(lock, [&startup] { return startup.done; });
    if (!startup.ok) {
      lock.unlock();
      audio_thread.join();
      EmitJson("{\"event\":\"stopped\",\"generation\":0}");
      CloseHandle(audio_done);
      CloseHandle(shared.control_event);
      return 1;
    }
  }

  InputLoop(shared, audio_done, options.default_fps);
  audio_thread.join();
  const std::uint64_t stopped_generation = AppliedGeneration(shared);
  EmitJson("{\"event\":\"stopped\",\"generation\":" +
           std::to_string(stopped_generation) + "}");

  CloseHandle(audio_done);
  CloseHandle(shared.control_event);
  return 0;
}
