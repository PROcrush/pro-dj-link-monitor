#include <array>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <vector>

#include "../src/ltc_generator.h"

namespace {

int ReadBcd(const std::array<int, 80>& bits, int offset, int width) {
  int value = 0;
  for (int bit = 0; bit < width; ++bit) {
    value += bits[static_cast<std::size_t>(offset + bit)] << bit;
  }
  return value;
}

std::array<int, 80> DecodeBits(const std::vector<std::int16_t>& pcm,
                               int fps, int frame_index) {
  const int samples_per_frame = prodjlink::kSampleRate / fps;
  const int samples_per_bit = samples_per_frame / 80;
  const int frame_start = frame_index * samples_per_frame;
  std::array<int, 80> bits{};
  for (int bit = 0; bit < 80; ++bit) {
    const int first = frame_start + bit * samples_per_bit + samples_per_bit / 4;
    const int second =
        frame_start + bit * samples_per_bit + (samples_per_bit * 3) / 4;
    const auto a = pcm[static_cast<std::size_t>(first * 2)];
    const auto b = pcm[static_cast<std::size_t>(second * 2)];
    bits[static_cast<std::size_t>(bit)] = (a < 0) == (b < 0) ? 0 : 1;
  }
  return bits;
}

std::uint64_t DecodeTotalFrames(const std::array<int, 80>& bits, int fps) {
  const int frames = ReadBcd(bits, 0, 4) + ReadBcd(bits, 8, 2) * 10;
  const int seconds = ReadBcd(bits, 16, 4) + ReadBcd(bits, 24, 3) * 10;
  const int minutes = ReadBcd(bits, 32, 4) + ReadBcd(bits, 40, 3) * 10;
  const int hours = ReadBcd(bits, 48, 4) + ReadBcd(bits, 56, 2) * 10;
  return static_cast<std::uint64_t>(((hours * 60 + minutes) * 60 + seconds) *
                                    fps + frames);
}

void TestKnownTimecode() {
  constexpr int fps = 25;
  const int samples = prodjlink::kSampleRate / fps;
  std::vector<std::int16_t> pcm(static_cast<std::size_t>(samples * 2));
  prodjlink::LtcGenerator generator(fps);
  const prodjlink::LtcMapping mapping{12345.0, 1.0, 0, fps};
  generator.Render(pcm.data(), samples, 0, mapping);

  const auto bits = DecodeBits(pcm, fps, 0);
  assert(DecodeTotalFrames(bits, fps) == 308);  // 00:00:12:08
  constexpr std::array<int, 16> sync = {
      0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1};
  for (std::size_t index = 0; index < sync.size(); ++index) {
    assert(bits[64 + index] == sync[index]);
  }
}

void TestHalfRateRepeatsFramesWithoutChangingLtcBitRate() {
  constexpr int fps = 25;
  const int samples_per_frame = prodjlink::kSampleRate / fps;
  const int samples = samples_per_frame * 3;
  std::vector<std::int16_t> pcm(static_cast<std::size_t>(samples * 2));
  prodjlink::LtcGenerator generator(fps);
  const prodjlink::LtcMapping mapping{1000.0, 0.5, 0, fps};
  generator.Render(pcm.data(), samples, 0, mapping);

  assert(DecodeTotalFrames(DecodeBits(pcm, fps, 0), fps) == 25);
  assert(DecodeTotalFrames(DecodeBits(pcm, fps, 1), fps) == 25);
  assert(DecodeTotalFrames(DecodeBits(pcm, fps, 2), fps) == 26);
}

}  // namespace

int main() {
  TestKnownTimecode();
  TestHalfRateRepeatsFramesWithoutChangingLtcBitRate();
  std::cout << "ltc_generator_test: ok\n";
  return 0;
}
