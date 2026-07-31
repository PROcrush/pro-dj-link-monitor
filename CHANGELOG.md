# Changelog

All notable changes from the first public release onward will be documented in
this file. The format follows Keep a Changelog and versions follow Semantic
Versioning where practical.

## [Unreleased]

### Added

- Initial public repository structure, licensing and contribution guidance.
- Cross-platform CI for the Node.js test suite.

### Security

- Local web outputs default to loopback; trusted-LAN access requires an
  explicit opt-in.
- Persistent waveform diagnostics are privacy-reduced before being written to
  disk.
