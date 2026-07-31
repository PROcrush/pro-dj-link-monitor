const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRmst,
  decodeAlbumArt,
  decodeBeatGrid,
  decodeBlueWaveformPreview,
  decodeExtendedCueList,
  decodeRgbWaveformDetail,
  decodeRgbWaveformPreview,
  decodeLegacyCueList,
  decodeThreeBandWaveformPreview,
  decodeUtf16Be,
  parseMetadataItems
} = require('../src/prolink/dbserver.cjs');

test('builds dbserver RMST request fields', () => {
  assert.equal(buildRmst(1, 1, 2, 1), 0x01010201);
  assert.equal(buildRmst(7, 8, 3, 1), 0x07080301);
});

test('decodes dbserver UTF-16BE strings', () => {
  const bytes = Buffer.from([0x00, 0x43, 0x00, 0x44, 0x00, 0x4a]);
  assert.equal(decodeUtf16Be(bytes), 'CDJ');
});

test('parses dbserver metadata menu items', () => {
  const metadata = parseMetadataItems([
    menuItem(0x0004, 'Chillout Jazz House Music Mix  Cozy Pancakes', 1),
    menuItem(0x0007, 'Test Artist', 12),
    menuItem(0x000b, '', 6041),
    menuItem(0x000d, '', 12158),
    menuItem(0x000f, 'Cm', 3)
  ]);

  assert.equal(metadata.title, 'Chillout Jazz House Music Mix  Cozy Pancakes');
  assert.equal(metadata.artist, 'Test Artist');
  assert.equal(metadata.durationSeconds, 6041);
  assert.equal(metadata.trackLengthMs, 6041000);
  assert.equal(metadata.tempo, 121.58);
  assert.equal(metadata.key, 'Cm');
});

test('decodes blue waveform preview bytes into renderable points', () => {
  const waveform = decodeBlueWaveformPreview(Buffer.from([0x00, 0x00, 0x1f, 0x07, 0x10, 0x03]));

  assert.equal(waveform.kind, 'small');
  assert.equal(waveform.style, 'blue');
  assert.equal(waveform.pointCount, 3);
  assert.deepEqual(waveform.points, [
    [0, 0],
    [255, 255],
    [132, 109]
  ]);
});

test('decodes RGB waveform preview bytes into renderable points', () => {
  const header = Buffer.alloc(28);
  const waveform = decodeRgbWaveformPreview(Buffer.concat([
    header,
    Buffer.from([
      0, 0, 0, 31, 0, 0,
      0, 0, 0, 0, 16, 31
    ])
  ]));

  assert.equal(waveform.kind, 'small');
  assert.equal(waveform.style, 'rgb');
  assert.equal(waveform.pointCount, 2);
  assert.deepEqual(waveform.points, [
    [255, 191, 0, 0, 0, 255, 0, 0],
    [255, 0, 98, 191, 255, 0, 131, 255]
  ]);
});

test('decodes CDJ-3000 3Band waveform preview bytes into renderable points', () => {
  const header = Buffer.alloc(28);
  const tagHeader = Buffer.alloc(8);
  tagHeader.writeUInt32BE(3, 0);
  tagHeader.writeUInt32BE(2, 4);
  const waveform = decodeThreeBandWaveformPreview(Buffer.concat([
    header,
    tagHeader,
    Buffer.from([
      20, 8, 31,
      31, 31, 31
    ])
  ]));

  assert.equal(waveform.kind, 'small');
  assert.equal(waveform.style, 'three-band');
  assert.equal(waveform.pointCount, 2);
  assert.deepEqual(waveform.points, [
    [117, 167, 182],
    [117, 194, 254]
  ]);
});

test('decodes RGB waveform detail bytes into renderable points', () => {
  const header = Buffer.alloc(28);
  const waveform = decodeRgbWaveformDetail(Buffer.concat([
    header,
    Buffer.from([0xe0, 0x7c, 0x1c, 0x7c])
  ]));

  assert.equal(waveform.kind, 'big');
  assert.equal(waveform.style, 'rgb');
  assert.equal(waveform.pointCount, 2);
  assert.equal(waveform.originalPointCount, 2);
  assert.deepEqual(waveform.points, [
    [255, 255, 0, 0],
    [255, 0, 0, 255]
  ]);
});

test('decodes Beat-Link style beat grid bytes', () => {
  const bytes = Buffer.alloc(20 + 16 * 2);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(12800, 22);
  bytes.writeUInt32LE(1000, 24);
  bytes.writeUInt16LE(2, 36);
  bytes.writeUInt16LE(12800, 38);
  bytes.writeUInt32LE(1469, 40);

  const beatGrid = decodeBeatGrid(bytes);

  assert.equal(beatGrid.beatCount, 2);
  assert.deepEqual(beatGrid.beats, [
    [1000, 1, 128],
    [1469, 2, 128]
  ]);
});

test('decodes legacy cue list entries', () => {
  const bytes = Buffer.alloc(36);
  bytes[1] = 1;
  bytes[2] = 1;
  bytes.writeUInt32LE(150, 12);

  const cueList = decodeLegacyCueList(bytes);

  assert.equal(cueList.sourceStyle, 'legacy');
  assert.equal(cueList.hotCueCount, 1);
  assert.equal(cueList.cues[0].label, 'A');
  assert.equal(cueList.cues[0].positionMs, 1000);
});

test('decodes extended cue list entries with loop and color', () => {
  const bytes = Buffer.alloc(0x52);
  bytes.writeUInt32LE(0x52, 0);
  bytes[4] = 2;
  bytes[6] = 2;
  bytes.writeUInt32LE(2000, 12);
  bytes.writeUInt32LE(4000, 16);
  bytes[0x4e] = 0x2a;

  const cueList = decodeExtendedCueList(bytes, 1);

  assert.equal(cueList.sourceStyle, 'extended');
  assert.equal(cueList.hotCueCount, 1);
  assert.equal(cueList.loopCount, 1);
  assert.equal(cueList.cues[0].label, 'B');
  assert.equal(cueList.cues[0].positionMs, 2000);
  assert.equal(cueList.cues[0].loopMs, 4000);
  assert.equal(cueList.cues[0].color, '#e62828');
});

test('decodes extended hot cue color after UTF-16 comment bytes', () => {
  const comment = Buffer.from('标记', 'utf16le');
  const commentSize = comment.length + 2;
  const entrySize = 0x4e + commentSize + 4;
  const bytes = Buffer.alloc(entrySize);
  bytes.writeUInt32LE(entrySize, 0);
  bytes[4] = 1;
  bytes[6] = 1;
  bytes.writeUInt32LE(3000, 12);
  bytes.writeUInt16LE(commentSize, 0x48);
  comment.copy(bytes, 0x4a);
  const colorOffset = 0x4e + commentSize;
  bytes[colorOffset + 1] = 0x12;
  bytes[colorOffset + 2] = 0x34;
  bytes[colorOffset + 3] = 0x56;

  const cueList = decodeExtendedCueList(bytes, 1);

  assert.equal(cueList.hotCueCount, 1);
  assert.equal(cueList.cues[0].label, 'A');
  assert.equal(cueList.cues[0].comment, '标记');
  assert.equal(cueList.cues[0].positionMs, 3000);
  assert.equal(cueList.cues[0].color, '#123456');
});

test('decodes album art bytes into a data URL', () => {
  const art = decodeAlbumArt(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 42);

  assert.equal(art.id, 42);
  assert.equal(art.mime, 'image/jpeg');
  assert.equal(art.byteLength, 4);
  assert.match(art.dataUrl, /^data:image\/jpeg;base64,/);
});

function menuItem(type, text, number) {
  return {
    type: 0x4101,
    args: [
      {kind: 'number', value: 0},
      {kind: 'number', value: number},
      {kind: 'number', value: text.length * 2 + 2},
      {kind: 'string', value: text},
      {kind: 'number', value: 2},
      {kind: 'string', value: ''},
      {kind: 'number', value: type},
      {kind: 'number', value: 0},
      {kind: 'number', value: 0}
    ]
  };
}
