'use strict';

const path = require('node:path');

function resolveMacAudioHelperPath(dirname = __dirname) {
  const helperPath = path.join(dirname, 'macAudioDevice.swift');
  const asarNeedle = `${path.sep}app.asar${path.sep}`;
  if (!helperPath.includes(asarNeedle)) return helperPath;
  return helperPath.replace(asarNeedle, `${path.sep}app.asar.unpacked${path.sep}`);
}

module.exports = {
  resolveMacAudioHelperPath
};
