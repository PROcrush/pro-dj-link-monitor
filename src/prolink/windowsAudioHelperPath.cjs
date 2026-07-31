'use strict';

const path = require('node:path');

const WINDOWS_AUDIO_HELPER_NAME = 'prodjlink-wasapi-ltc.exe';

function resolveWindowsAudioHelperPath(dirname, arch = process.arch, env = process.env) {
  const override = String(env.PRODJLINK_WASAPI_HELPER || '').trim();
  if (override) return override;
  const helperPath = path.join(
    dirname,
    '..',
    'windows-audio-helper',
    'bin',
    normalizeWindowsArch(arch),
    WINDOWS_AUDIO_HELPER_NAME
  );
  const asarNeedle = `${path.sep}app.asar${path.sep}`;
  if (!helperPath.includes(asarNeedle)) return helperPath;
  return helperPath.replace(asarNeedle, `${path.sep}app.asar.unpacked${path.sep}`);
}

function normalizeWindowsArch(arch) {
  return arch === 'arm64' ? 'arm64' : 'x64';
}

module.exports = {
  normalizeWindowsArch,
  resolveWindowsAudioHelperPath,
  WINDOWS_AUDIO_HELPER_NAME
};
