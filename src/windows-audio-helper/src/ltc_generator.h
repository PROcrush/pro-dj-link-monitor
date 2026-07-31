#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace prodjlink {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;
constexpr int kBitsPerSample = 16;

inline bool IsSupportedFps(int fps) {
  return fps == 24 || fps == 25 || fps == 30;
}

struct LtcMapping {
  double elapsed_ms = 0.0;
  double rate = 1.0;
  std::uint64_t anchor_sample = 0;
  int fps = 25;
};

inline void WriteBcd(std::array<int, 80>& bits, int offset, int value,
                     int width) {
  for (int bit = 0; bit < width; ++bit) {
    bits[static_cast<std::size_t>(offset + bit)] = (value >> bit) & 1;
  }
}

inline std::array<int, 80> MakeLtcFrameBits(std::uint64_t total_frames,
                                            int fps) {
  std::array<int, 80> bits{};
  const int frames = static_cast<int>(total_frames % fps);
  const std::uint64_t total_seconds = total_frames / fps;
  const int seconds = static_cast<int>(total_seconds % 60);
  const std::uint64_t total_minutes = total_seconds / 60;
  const int minutes = static_cast<int>(total_minutes % 60);
  const int hours = static_cast<int>((total_minutes / 60) % 24);

  WriteBcd(bits, 0, frames % 10, 4);
  WriteBcd(bits, 8, frames / 10, 2);
  WriteBcd(bits, 16, seconds % 10, 4);
  WriteBcd(bits, 24, seconds / 10, 3);
  WriteBcd(bits, 32, minutes % 10, 4);
  WriteBcd(bits, 40, minutes / 10, 3);
  WriteBcd(bits, 48, hours % 10, 4);
  WriteBcd(bits, 56, hours / 10, 2);

  constexpr std::array<int, 16> kSyncWord = {
      0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1};
  for (std::size_t index = 0; index < kSyncWord.size(); ++index) {
    bits[64 + index] = kSyncWord[index];
  }

  const int correction_bit = fps == 25 ? 59 : 27;
  int ones = 0;
  for (std::size_t index = 0; index < bits.size(); ++index) {
    if (static_cast<int>(index) != correction_bit) {
      ones += bits[index];
    }
  }
  bits[static_cast<std::size_t>(correction_bit)] = ones % 2;
  return bits;
}

class LtcGenerator {
 public:
  explicit LtcGenerator(int fps = 25, double amplitude = 0.55) {
    SetAmplitude(amplitude);
    Reset(fps);
  }

  void SetAmplitude(double amplitude) {
    const double normalized = std::max(0.0, std::min(1.0, amplitude));
    amplitude_ = static_cast<std::int16_t>(
        std::max(1L, std::lround(normalized * 32767.0)));
  }

  void Reset(int fps) {
    fps_ = IsSupportedFps(fps) ? fps : 25;
    samples_per_frame_ = kSampleRate / fps_;
    samples_per_bit_ = samples_per_frame_ / 80;
    sample_in_frame_ = 0;
    bits_.fill(0);
    target_ = static_cast<std::int16_t>(-amplitude_);
    previous_target_ = target_;
    samples_since_transition_ = kRiseSamples;
  }

  void Render(std::int16_t* interleaved, std::uint32_t frame_count,
              std::uint64_t first_sample, const LtcMapping& mapping) {
    if (mapping.fps != fps_) {
      Reset(mapping.fps);
    }

    for (std::uint32_t frame = 0; frame < frame_count; ++frame) {
      const std::uint64_t absolute_sample = first_sample + frame;
      if (sample_in_frame_ == 0) {
        BeginFrame(absolute_sample, mapping);
      }

      const int bit_index = sample_in_frame_ / samples_per_bit_;
      const int sample_in_bit = sample_in_frame_ % samples_per_bit_;
      if (sample_in_bit == 0) {
        ToggleTarget();
      }
      if (bits_[static_cast<std::size_t>(bit_index)] == 1 &&
          sample_in_bit == samples_per_bit_ / 2) {
        ToggleTarget();
      }

      const std::int16_t value = ShapedValue();
      interleaved[frame * kChannels] = value;
      interleaved[frame * kChannels + 1] = value;

      ++samples_since_transition_;
      ++sample_in_frame_;
      if (sample_in_frame_ == samples_per_frame_) {
        sample_in_frame_ = 0;
      }
    }
  }

 private:
  static constexpr int kRiseSamples = 2;

  void BeginFrame(std::uint64_t absolute_sample, const LtcMapping& mapping) {
    const double sample_delta =
        static_cast<double>(absolute_sample) -
        static_cast<double>(mapping.anchor_sample);
    const double position_ms = std::max(
        0.0, mapping.elapsed_ms +
                 (sample_delta * 1000.0 / kSampleRate) * mapping.rate);
    constexpr double kMillisecondsPerDay = 24.0 * 60.0 * 60.0 * 1000.0;
    const double wrapped_position_ms =
        std::fmod(position_ms, kMillisecondsPerDay);
    const auto total_frames = static_cast<std::uint64_t>(
        std::floor(wrapped_position_ms * static_cast<double>(mapping.fps) /
                   1000.0));
    bits_ = MakeLtcFrameBits(total_frames, mapping.fps);
  }

  void ToggleTarget() {
    previous_target_ = target_;
    target_ = target_ > 0 ? static_cast<std::int16_t>(-amplitude_)
                          : amplitude_;
    samples_since_transition_ = 0;
  }

  std::int16_t ShapedValue() const {
    if (samples_since_transition_ >= kRiseSamples) {
      return target_;
    }
    const double ratio =
        static_cast<double>(samples_since_transition_ + 1) / kRiseSamples;
    return static_cast<std::int16_t>(std::lround(
        previous_target_ + (target_ - previous_target_) * ratio));
  }

  int fps_ = 25;
  int samples_per_frame_ = kSampleRate / 25;
  int samples_per_bit_ = kSampleRate / 25 / 80;
  int sample_in_frame_ = 0;
  std::array<int, 80> bits_{};
  std::int16_t amplitude_ = 18022;
  std::int16_t target_ = -18022;
  std::int16_t previous_target_ = -18022;
  int samples_since_transition_ = kRiseSamples;
};

}  // namespace prodjlink
