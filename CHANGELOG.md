# Changelog

All notable changes from the first public release onward will be documented in
this file. The format follows Keep a Changelog and versions follow Semantic
Versioning where practical.

## [Unreleased]

No changes yet.

## [1.4.4] - 2026-08-01

### Added

- Initial public repository structure, licensing and contribution guidance.
- Cross-platform CI for the Node.js test suite.
- Unsigned preview packages for macOS Apple Silicon and Windows x64, with
  SHA-256 checksums.

### Security

- Local web outputs default to loopback; trusted-LAN access requires an
  explicit opt-in.
- Persistent waveform diagnostics are privacy-reduced before being written to
  disk.

[Unreleased]: https://github.com/PROcrush/pro-dj-link-monitor/compare/v1.4.4...HEAD
[1.4.4]: https://github.com/PROcrush/pro-dj-link-monitor/releases/tag/v1.4.4
