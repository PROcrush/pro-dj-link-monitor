const net = require('node:net');

const DB_QUERY_PORT = 12523;
const DB_QUERY_PACKET = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x0f]), Buffer.from('RemoteDBServer\0', 'ascii')]);
const MESSAGE_START = 0x872349ae;
const DEFAULT_TIMEOUT_MS = 5000;

const MESSAGE_TYPES = Object.freeze({
  setupRequest: 0x0000,
  teardownRequest: 0x0100,
  rekordboxMetadataRequest: 0x2002,
  albumArtRequest: 0x2003,
  wavePreviewRequest: 0x2004,
  cueListRequest: 0x2104,
  beatGridRequest: 0x2204,
  waveDetailRequest: 0x2904,
  cueListExtRequest: 0x2b04,
  anlzTagRequest: 0x2c04,
  renderMenuRequest: 0x3000,
  menuAvailable: 0x4000,
  albumArt: 0x4002,
  menuHeader: 0x4001,
  unavailable: 0x4003,
  menuItem: 0x4101,
  menuFooter: 0x4201,
  wavePreview: 0x4402,
  beatGrid: 0x4602,
  cueList: 0x4702,
  waveDetail: 0x4a02,
  cueListExt: 0x4e02,
  anlzTag: 0x4f02
});

const ANLZ_TAGS = Object.freeze({
  threeBandWaveformPreview: 0x36565750,
  threeBandWaveformDetail: 0x37565750,
  colorWaveformPreview: 0x34565750,
  colorWaveformDetail: 0x35565750,
  fileTypeExt: 0x00545845,
  fileType2Ex: 0x00584532
});

const MAX_WAVEFORM_DETAIL_POINTS = 6000;

const MENU_IDS = Object.freeze({
  main: 1,
  data: 8
});

const MENU_ITEM_TYPES = Object.freeze({
  albumTitle: 0x0002,
  trackTitle: 0x0004,
  genre: 0x0006,
  artist: 0x0007,
  rating: 0x000a,
  duration: 0x000b,
  tempo: 0x000d,
  label: 0x000e,
  key: 0x000f,
  year: 0x0011,
  comment: 0x0023,
  originalArtist: 0x0028,
  remixer: 0x0029,
  dateAdded: 0x002e
});

async function requestTrackData(options = {}) {
  const host = options.host;
  const targetPlayer = Number(options.targetPlayer || options.deviceId || 0);
  const posingPlayer = Number(options.posingPlayer || targetPlayer || 1);
  const slot = Number(options.slot || 0);
  const trackType = Number(options.trackType || 1);
  const trackId = Number(options.trackId || 0);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);

  if (!host || !targetPlayer || !slot || !trackId) return null;

  const port = await queryDbServerPort(host, timeoutMs);
  if (!port || port === 0xffff) return null;

  const session = await connectDbServer({host, port, targetPlayer, posingPlayer, timeoutMs});
  try {
    const track = {posingPlayer, slot, trackType, trackId};
    const metadata = await requestMetadata(session, track);
    const waveforms = options.waveform === false ? [] : await requestWaveforms(session, track);
    const beatGrid = options.beatGrid === false ? null : await tryRequestWaveform(() => requestBeatGrid(session, track));
    const cues = options.cues === false ? null : await tryRequestWaveform(() => requestCueList(session, track));
    const artwork = options.artwork === false ? null : await tryRequestWaveform(() => requestAlbumArt(session, {
      ...track,
      artworkId: metadata?.artworkId || 0
    }));
    return {metadata, waveform: waveforms[0] || null, waveforms, beatGrid, cues, artwork, dbPort: port};
  } finally {
    await session.close();
  }
}

async function requestTrackCues(options = {}) {
  const host = options.host;
  const targetPlayer = Number(options.targetPlayer || options.deviceId || 0);
  const posingPlayer = Number(options.posingPlayer || targetPlayer || 1);
  const slot = Number(options.slot || 0);
  const trackType = Number(options.trackType || 1);
  const trackId = Number(options.trackId || 0);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);

  if (!host || !targetPlayer || !slot || !trackId) return null;

  const port = await queryDbServerPort(host, timeoutMs);
  if (!port || port === 0xffff) return null;

  const session = await connectDbServer({host, port, targetPlayer, posingPlayer, timeoutMs});
  try {
    const cues = await tryRequestWaveform(() => requestCueList(session, {posingPlayer, slot, trackType, trackId}));
    return {cues, dbPort: port};
  } finally {
    await session.close();
  }
}

async function queryDbServerPort(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const socket = net.createConnection({host, port: DB_QUERY_PORT, timeout: timeoutMs});
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('dbserver query timeout')));
  await onceConnect(socket);
  await writeAll(socket, DB_QUERY_PACKET);
  const reader = makeReader(socket);
  const response = await reader.readExact(2);
  socket.destroy();
  return response.readUInt16BE(0);
}

async function connectDbServer({host, port, targetPlayer, posingPlayer, timeoutMs = DEFAULT_TIMEOUT_MS}) {
  const socket = net.createConnection({host, port, timeout: timeoutMs});
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('dbserver socket timeout')));
  await onceConnect(socket);
  socket.setNoDelay(true);
  const session = {
    socket,
    reader: makeReader(socket),
    tx: 0,
    close: async () => {
      try {
        await sendMessage(session, 0xfffffffe, MESSAGE_TYPES.teardownRequest, []);
      } catch (_error) {
        // The player often closes the socket immediately after teardown.
      }
      socket.destroy();
    }
  };

  await writeAll(socket, numberField(1, 4));
  const greeting = await readField(session);
  if (greeting.kind !== 'number' || greeting.value !== 1) throw new Error('Unexpected dbserver greeting response');

  await sendMessage(session, 0xfffffffe, MESSAGE_TYPES.setupRequest, [numberArg(posingPlayer, 4)]);
  const setup = await readMessage(session);
  if (setup.type !== MESSAGE_TYPES.menuAvailable || setup.args[1]?.value !== targetPlayer) {
    throw new Error(`Unexpected dbserver setup response from ${host}:${port}`);
  }

  return session;
}

async function requestMetadata(session, track) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.main, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.rekordboxMetadataRequest, [numberArg(rmst), numberArg(track.trackId)]);
  const available = await readMessage(session);
  if (available.type !== MESSAGE_TYPES.menuAvailable) return null;
  const count = available.args[1]?.value || 0;
  if (!count || count === 0xffffffff) return null;

  const items = await renderMenuItems(session, {
    rmst,
    slot: track.slot,
    trackType: track.trackType,
    count: Math.min(count, 64)
  });
  return parseMetadataItems(items);
}

async function requestWaveformPreviews(session, track) {
  const waveforms = [];
  const threeBand = await tryRequestWaveform(() => requestThreeBandWaveformPreview(session, track));
  if (threeBand) waveforms.push(threeBand);

  const rgb = await tryRequestWaveform(() => requestRgbWaveformPreview(session, track));
  if (rgb) waveforms.push(rgb);

  const blue = await tryRequestWaveform(() => requestBlueWaveformPreview(session, track));
  if (blue) waveforms.push(blue);

  return waveforms;
}

async function requestWaveforms(session, track) {
  const previews = await requestWaveformPreviews(session, track);
  const details = [];

  const threeBandDetail = await tryRequestWaveform(() => requestThreeBandWaveformDetail(session, track));
  if (threeBandDetail) details.push(threeBandDetail);

  const rgbDetail = await tryRequestWaveform(() => requestRgbWaveformDetail(session, track));
  if (rgbDetail) details.push(rgbDetail);

  const blueDetail = await tryRequestWaveform(() => requestBlueWaveformDetail(session, track));
  if (blueDetail) details.push(blueDetail);

  return [...previews, ...details];
}

async function tryRequestWaveform(request) {
  try {
    return await request();
  } catch (_error) {
    return null;
  }
}

async function requestWaveformPreview(session, track) {
  const waveforms = await requestWaveformPreviews(session, track);
  return waveforms[0] || null;
}

async function requestBlueWaveformPreview(session, track) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.data, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.wavePreviewRequest, [
    numberArg(rmst),
    numberArg(1),
    numberArg(track.trackId),
    numberArg(0)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type !== MESSAGE_TYPES.wavePreview) return null;
  const bytes = response.args[3]?.value;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  return decodeBlueWaveformPreview(bytes);
}

async function requestThreeBandWaveformPreview(session, track) {
  const bytes = await requestAnlzWaveformPreview(session, track, ANLZ_TAGS.threeBandWaveformPreview, ANLZ_TAGS.fileType2Ex);
  if (!bytes) return null;
  return decodeThreeBandWaveformPreview(bytes);
}

async function requestRgbWaveformPreview(session, track) {
  const bytes = await requestAnlzWaveformPreview(session, track, ANLZ_TAGS.colorWaveformPreview, ANLZ_TAGS.fileTypeExt);
  if (!bytes) return null;
  return decodeRgbWaveformPreview(bytes);
}

async function requestThreeBandWaveformDetail(session, track) {
  const bytes = await requestAnlzWaveformPreview(session, track, ANLZ_TAGS.threeBandWaveformDetail, ANLZ_TAGS.fileType2Ex);
  if (!bytes) return null;
  return decodeThreeBandWaveformDetail(bytes);
}

async function requestRgbWaveformDetail(session, track) {
  const bytes = await requestAnlzWaveformPreview(session, track, ANLZ_TAGS.colorWaveformDetail, ANLZ_TAGS.fileTypeExt);
  if (!bytes) return null;
  return decodeRgbWaveformDetail(bytes);
}

async function requestBlueWaveformDetail(session, track) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.main, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.waveDetailRequest, [
    numberArg(rmst),
    numberArg(track.trackId),
    numberArg(0)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type !== MESSAGE_TYPES.waveDetail) return null;
  const bytes = response.args[3]?.value;
  if (!Buffer.isBuffer(bytes) || bytes.length <= 19) return null;
  return decodeBlueWaveformDetail(bytes);
}

async function requestBeatGrid(session, track) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.data, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.beatGridRequest, [
    numberArg(rmst),
    numberArg(track.trackId)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type !== MESSAGE_TYPES.beatGrid) return null;
  const bytes = response.args[3]?.value;
  if (!Buffer.isBuffer(bytes) || bytes.length <= 20) return null;
  return decodeBeatGrid(bytes);
}

async function requestCueList(session, track) {
  const extended = await tryRequestWaveform(() => requestExtendedCueList(session, track));
  if (extended) return extended;
  return await tryRequestWaveform(() => requestLegacyCueList(session, track));
}

async function requestExtendedCueList(session, track) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.data, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.cueListExtRequest, [
    numberArg(rmst),
    numberArg(track.trackId),
    numberArg(0)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type !== MESSAGE_TYPES.cueListExt) return null;
  const bytes = response.args[3]?.value;
  const entryCount = response.args[4]?.value || 0;
  if (!Buffer.isBuffer(bytes) || !bytes.length || !entryCount) return null;
  return decodeExtendedCueList(bytes, entryCount);
}

async function requestLegacyCueList(session, track) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.data, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.cueListRequest, [
    numberArg(rmst),
    numberArg(track.trackId)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type !== MESSAGE_TYPES.cueList) return null;
  const bytes = response.args[3]?.value;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  return decodeLegacyCueList(bytes);
}

async function requestAlbumArt(session, track) {
  if (!track.artworkId) return null;
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.main, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.albumArtRequest, [
    numberArg(rmst),
    numberArg(track.artworkId)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type !== MESSAGE_TYPES.albumArt) return null;
  const bytes = response.args[3]?.value;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  return decodeAlbumArt(bytes, track.artworkId);
}

async function requestAnlzWaveformPreview(session, track, tagType, fileType) {
  const tx = nextTx(session);
  const rmst = buildRmst(track.posingPlayer, MENU_IDS.main, track.slot, track.trackType);
  await sendMessage(session, tx, MESSAGE_TYPES.anlzTagRequest, [
    numberArg(rmst),
    numberArg(track.trackId),
    numberArg(tagType),
    numberArg(fileType)
  ]);
  const response = await readMessage(session);
  if (response.tx !== tx || response.type === MESSAGE_TYPES.unavailable) return null;
  if (response.type !== MESSAGE_TYPES.anlzTag) return null;
  const bytes = response.args[3]?.value;
  if (!Buffer.isBuffer(bytes) || bytes.length <= 28) return null;
  return bytes;
}

async function renderMenuItems(session, {rmst, count}) {
  const tx = nextTx(session);
  await sendMessage(session, tx, MESSAGE_TYPES.renderMenuRequest, [
    numberArg(rmst),
    numberArg(0),
    numberArg(count),
    numberArg(0),
    numberArg(count),
    numberArg(0)
  ]);

  const header = await readMessage(session);
  if (header.tx !== tx || header.type !== MESSAGE_TYPES.menuHeader) return [];

  const items = [];
  for (;;) {
    const message = await readMessage(session);
    if (message.tx !== tx) throw new Error('Received dbserver menu response with wrong transaction id');
    if (message.type === MESSAGE_TYPES.menuFooter) return items;
    if (message.type === MESSAGE_TYPES.menuItem) items.push(message);
  }
}

function parseMetadataItems(items) {
  const metadata = {};
  for (const item of items || []) {
    const type = item.args[6]?.value;
    const text = item.args[3]?.value || '';
    const numeric = item.args[1]?.value || 0;

    switch (type) {
      case MENU_ITEM_TYPES.trackTitle:
        metadata.title = text;
        metadata.artworkId = item.args[8]?.value || 0;
        break;
      case MENU_ITEM_TYPES.artist:
        metadata.artist = text;
        metadata.artistId = numeric;
        break;
      case MENU_ITEM_TYPES.albumTitle:
        metadata.album = text;
        metadata.albumId = numeric;
        break;
      case MENU_ITEM_TYPES.duration:
        metadata.durationSeconds = numeric;
        metadata.trackLengthMs = numeric ? numeric * 1000 : null;
        break;
      case MENU_ITEM_TYPES.tempo:
        metadata.tempo = numeric ? Number((numeric / 100).toFixed(2)) : null;
        break;
      case MENU_ITEM_TYPES.key:
        metadata.key = text;
        break;
      case MENU_ITEM_TYPES.comment:
        metadata.comment = text;
        break;
      case MENU_ITEM_TYPES.dateAdded:
        metadata.dateAdded = text;
        break;
    }
  }
  return metadata;
}

function decodeBlueWaveformPreview(bytes) {
  const points = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const height = bytes[index] & 0x1f;
    const intensity = bytes[index + 1] & 0x07;
    points.push([
      Math.round((height / 31) * 255),
      Math.round((intensity / 7) * 255)
    ]);
  }
  return {
    kind: 'small',
    style: 'blue',
    pointCount: points.length,
    points
  };
}

function decodeRgbWaveformPreview(bytes) {
  const data = bytes.subarray(28);
  const points = [];
  for (let index = 0; index + 5 < data.length; index += 6) {
    const redRaw = data[index + 3];
    const greenRaw = data[index + 4];
    const blueRaw = data[index + 5];
    const backHeight = Math.max(blueRaw, redRaw, greenRaw);
    const frontHeight = blueRaw;
    const backColor = normalizeRgbWaveformColor(redRaw, greenRaw, blueRaw, backHeight, 191);
    const frontColor = normalizeRgbWaveformColor(redRaw, greenRaw, blueRaw, backHeight, 255);
    points.push([
      scaleWaveformByte(backHeight),
      ...backColor,
      scaleWaveformByte(frontHeight),
      ...frontColor
    ]);
  }
  return {
    kind: 'small',
    style: 'rgb',
    pointCount: points.length,
    points
  };
}

function decodeThreeBandWaveformPreview(bytes) {
  let data = bytes.subarray(28);
  if (data.length >= 8) {
    const entryBytes = data.readUInt32BE(0);
    const entryCount = data.readUInt32BE(4);
    const dataLength = entryBytes * entryCount;
    if (entryBytes === 3 && entryCount > 0 && data.length >= dataLength + 8) {
      data = data.subarray(8, 8 + dataLength);
    }
  }

  const points = [];
  for (let index = 0; index + 2 < data.length; index += 3) {
    const midRaw = data[index];
    const highRaw = data[index + 1];
    const lowRaw = data[index + 2];
    const low = lowRaw * 0.49;
    const mid = low + midRaw * 0.32;
    const high = mid + highRaw * 0.25;
    points.push([
      scaleThreeBandHeight(low),
      scaleThreeBandHeight(mid),
      scaleThreeBandHeight(high)
    ]);
  }
  return {
    kind: 'small',
    style: 'three-band',
    pointCount: points.length,
    points
  };
}

function decodeBlueWaveformDetail(bytes) {
  const data = bytes.subarray(19);
  const rawPoints = [];
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    const height = value & 0x1f;
    const intensity = (value & 0xe0) >> 5;
    rawPoints.push([
      Math.round((height / 31) * 255),
      Math.round((intensity / 7) * 255)
    ]);
  }
  return makeDetailWaveform('blue', rawPoints, data.length);
}

function decodeRgbWaveformDetail(bytes) {
  const data = bytes.subarray(28);
  const rawPoints = [];
  for (let index = 0; index + 1 < data.length; index += 2) {
    const bits = (data[index] << 8) + data[index + 1];
    const height = (bits >> 2) & 0x1f;
    const red = (bits >> 13) & 0x07;
    const green = (bits >> 10) & 0x07;
    const blue = (bits >> 7) & 0x07;
    rawPoints.push([
      Math.round((height / 31) * 255),
      Math.round((red / 7) * 255),
      Math.round((blue / 7) * 255),
      Math.round((green / 7) * 255)
    ]);
  }
  return makeDetailWaveform('rgb', rawPoints, rawPoints.length);
}

function decodeThreeBandWaveformDetail(bytes) {
  const data = stripAnlzEntryHeader(bytes.subarray(28), 3);
  const rawPoints = [];
  for (let index = 0; index + 2 < data.length; index += 3) {
    const midRaw = data[index];
    const highRaw = data[index + 1];
    const lowRaw = data[index + 2];
    const low = lowRaw * 0.4;
    const mid = low + midRaw * 0.3;
    const high = mid + highRaw * 0.06;
    rawPoints.push([
      scaleDetailHeight(low),
      scaleDetailHeight(mid),
      scaleDetailHeight(high)
    ]);
  }
  return makeDetailWaveform('three-band', rawPoints, rawPoints.length);
}

function decodeBeatGrid(bytes) {
  const beats = [];
  const beatCount = Math.max(0, Math.floor((bytes.length - 20) / 16));
  for (let beatIndex = 0; beatIndex < beatCount; beatIndex += 1) {
    const offset = 20 + beatIndex * 16;
    const beatWithinBar = readUInt16LE(bytes, offset);
    const rawBpm = readUInt16LE(bytes, offset + 2);
    const timeMs = readUInt32LE(bytes, offset + 4);
    beats.push([
      timeMs,
      beatWithinBar,
      rawBpm ? Number((rawBpm / 100).toFixed(2)) : null
    ]);
  }
  return {
    beatCount: beats.length,
    beats
  };
}

function decodeLegacyCueList(bytes) {
  const entries = [];
  const entryCount = Math.floor(bytes.length / 36);
  for (let index = 0; index < entryCount; index += 1) {
    const offset = index * 36;
    const cueFlag = bytes[offset + 1] || 0;
    const hotCueNumber = bytes[offset + 2] || 0;
    if (cueFlag === 0 && hotCueNumber === 0) continue;
    const position = readUInt32LE(bytes, offset + 12);
    const isLoop = bytes[offset] !== 0;
    const loopPosition = isLoop ? readUInt32LE(bytes, offset + 16) : null;
    entries.push(makeCueEntry({
      hotCueNumber,
      isLoop,
      positionMs: halfFrameToMs(position),
      loopMs: loopPosition === null ? null : halfFrameToMs(loopPosition),
      comment: '',
      color: cueColor({hotCueNumber, isLoop})
    }));
  }
  return normalizeCueList(entries, 'legacy');
}

function decodeExtendedCueList(bytes, entryCount) {
  const entries = [];
  let offset = 0;
  for (let index = 0; index < entryCount && offset + 16 <= bytes.length; index += 1) {
    const entrySize = readUInt32LE(bytes, offset);
    if (!entrySize || offset + entrySize > bytes.length) break;
    const cueFlag = bytes[offset + 6] || 0;
    const hotCueNumber = bytes[offset + 4] || 0;
    if (cueFlag !== 0 || hotCueNumber !== 0) {
      const rawPositionMs = readUInt32LE(bytes, offset + 12);
      const isLoop = cueFlag === 2;
      const rawLoopMs = isLoop ? readUInt32LE(bytes, offset + 16) : null;
      const comment = readExtendedCueComment(bytes, offset, entrySize);
      const color = extendedCueColor(bytes, offset, entrySize, comment.byteLength, hotCueNumber, isLoop);
      entries.push(makeCueEntry({
        hotCueNumber,
        isLoop,
        positionMs: normalizeCueMs(rawPositionMs),
        loopMs: rawLoopMs === null ? null : normalizeCueMs(rawLoopMs),
        comment: comment.text,
        color
      }));
    }
    offset += entrySize;
  }
  return normalizeCueList(entries, 'extended');
}

function decodeAlbumArt(bytes, artworkId) {
  const mime = detectImageMime(bytes);
  return {
    id: artworkId,
    mime,
    byteLength: bytes.length,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`
  };
}

function makeDetailWaveform(style, rawPoints, originalPointCount) {
  const points = downsampleWaveformPoints(rawPoints, MAX_WAVEFORM_DETAIL_POINTS);
  return {
    kind: 'big',
    style,
    pointCount: points.length,
    originalPointCount,
    totalTimeMs: Math.round((originalPointCount * 1000) / 150),
    downsampled: points.length !== originalPointCount,
    points
  };
}

function downsampleWaveformPoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const downsampled = [];
  for (let outputIndex = 0; outputIndex < maxPoints; outputIndex += 1) {
    const start = Math.floor(outputIndex * step);
    const end = Math.max(start + 1, Math.floor((outputIndex + 1) * step));
    downsampled.push(aggregateWaveformPoints(points, start, Math.min(points.length, end)));
  }
  return downsampled;
}

function aggregateWaveformPoints(points, start, end) {
  const sample = points[start] || [0];
  const output = new Array(sample.length).fill(0);
  for (let index = start; index < end; index += 1) {
    const point = points[index] || sample;
    for (let part = 0; part < output.length; part += 1) {
      output[part] = Math.max(output[part], Number(point[part] || 0));
    }
  }
  return output;
}

function normalizeCueList(entries, sourceStyle) {
  const sorted = entries
    .filter((entry) => Number.isFinite(entry.positionMs))
    .sort((a, b) => {
      if (a.positionMs !== b.positionMs) return a.positionMs - b.positionMs;
      return (a.hotCueNumber ? 1 : 0) - (b.hotCueNumber ? 1 : 0);
    });
  return {
    sourceStyle,
    cueCount: sorted.length,
    hotCueCount: sorted.filter((entry) => entry.hotCueNumber > 0).length,
    memoryCount: sorted.filter((entry) => entry.hotCueNumber === 0).length,
    loopCount: sorted.filter((entry) => entry.isLoop).length,
    cues: sorted
  };
}

function makeCueEntry({hotCueNumber, isLoop, positionMs, loopMs, comment, color}) {
  const number = Number(hotCueNumber || 0);
  const kind = number > 0 ? (isLoop ? 'hot-loop' : 'hot-cue') : (isLoop ? 'memory-loop' : 'memory');
  return {
    hotCueNumber: number,
    label: number > 0 ? String.fromCharCode(64 + number) : (isLoop ? 'Loop' : 'Memory'),
    kind,
    isLoop: Boolean(isLoop),
    positionMs,
    loopMs,
    comment: String(comment || '').trim(),
    color
  };
}

function readExtendedCueComment(bytes, offset, entrySize) {
  if (entrySize <= 0x49) return {text: '', byteLength: 0};
  const commentSize = readUInt16LE(bytes, offset + 0x48);
  if (!commentSize || commentSize < 2 || offset + 0x4a + commentSize > bytes.length) return {text: '', byteLength: 0};
  return {
    text: bytes.subarray(offset + 0x4a, offset + 0x4a + commentSize - 2).toString('utf16le').trim(),
    byteLength: commentSize
  };
}

function extendedCueColor(bytes, offset, entrySize, commentByteLength, hotCueNumber, isLoop) {
  if (!hotCueNumber) {
    const colorId = offset + 0x22 < bytes.length ? bytes[offset + 0x22] : 0;
    return memoryColor(colorId) || cueColor({hotCueNumber, isLoop});
  }
  const colorOffset = offset + Number(commentByteLength || 0) + 0x4e;
  const limit = offset + entrySize;
  const colorCode = safelyFetchByte(bytes, colorOffset, limit);
  const red = safelyFetchByte(bytes, colorOffset + 1, limit);
  const green = safelyFetchByte(bytes, colorOffset + 2, limit);
  const blue = safelyFetchByte(bytes, colorOffset + 3, limit);
  const rekordboxColor = rekordboxCueColor(colorCode);
  if (rekordboxColor) return rekordboxColor;
  if (red || green || blue) return rgbHex(red, green, blue);
  return cueColor({hotCueNumber, isLoop});
}

function safelyFetchByte(bytes, index, limit) {
  if (index < 0 || index >= limit || index >= bytes.length) return 0;
  return bytes[index] || 0;
}

function cueColor({hotCueNumber, isLoop}) {
  if (hotCueNumber > 0) return '#55d682';
  if (isLoop) return '#e5b552';
  return '#df6b68';
}

function memoryColor(colorId) {
  const colors = {
    1: '#df6b68',
    2: '#ff9a3d',
    3: '#e5d452',
    4: '#55d682',
    5: '#35d7ee',
    6: '#4d8dff',
    7: '#b478ff',
    8: '#ff61b6'
  };
  return colors[colorId] || null;
}

function rekordboxCueColor(colorCode) {
  const color = REKORDBOX_CUE_COLORS[colorCode];
  return color ? rgbHex(color[0], color[1], color[2]) : null;
}

function detectImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  return 'application/octet-stream';
}

function stripAnlzEntryHeader(data, entryBytes) {
  if (data.length >= 8) {
    const size = data.readUInt32BE(0);
    const count = data.readUInt32BE(4);
    const dataLength = size * count;
    if (size === entryBytes && count > 0 && data.length >= dataLength + 8) {
      return data.subarray(8, 8 + dataLength);
    }
  }
  return data;
}

function normalizeRgbWaveformColor(red, green, blue, height, maxLevel) {
  if (!height) return [0, 0, 0];
  return [
    Math.floor((red * maxLevel) / height),
    Math.floor((green * maxLevel) / height),
    Math.floor((blue * maxLevel) / height)
  ];
}

function scaleWaveformByte(value) {
  const numeric = Number(value || 0);
  if (numeric <= 31) return Math.round((numeric / 31) * 255);
  return Math.max(0, Math.min(255, numeric));
}

function scaleThreeBandHeight(value) {
  const numeric = Number(value || 0);
  return Math.max(0, Math.min(255, Math.round((numeric / 33) * 255)));
}

function scaleDetailHeight(value) {
  const numeric = Number(value || 0);
  return Math.max(0, Math.min(255, Math.round((numeric / 31) * 255)));
}

function halfFrameToMs(position) {
  return Math.round((Number(position || 0) * 1000) / 150);
}

function normalizeCueMs(ms) {
  return halfFrameToMs(Math.round((Number(ms || 0) * 150) / 1000));
}

function rgbHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Number(value || 0).toString(16).padStart(2, '0')).join('')}`;
}

const REKORDBOX_CUE_COLORS = Object.freeze({
  0x01: [0x30, 0x5a, 0xff], 0x02: [0x50, 0x73, 0xff], 0x03: [0x50, 0x8c, 0xff], 0x04: [0x50, 0xa0, 0xff],
  0x05: [0x50, 0xb4, 0xff], 0x06: [0x50, 0xb0, 0xf2], 0x07: [0x50, 0xae, 0xe8], 0x08: [0x45, 0xac, 0xdb],
  0x09: [0x00, 0xe0, 0xff], 0x0a: [0x19, 0xda, 0xf0], 0x0b: [0x32, 0xd2, 0xe6], 0x0c: [0x21, 0xb4, 0xb9],
  0x0d: [0x20, 0xaa, 0xa0], 0x0e: [0x1f, 0xa3, 0x92], 0x0f: [0x19, 0xa0, 0x8c], 0x10: [0x14, 0xa5, 0x84],
  0x11: [0x14, 0xaa, 0x7d], 0x12: [0x10, 0xb1, 0x76], 0x13: [0x30, 0xd2, 0x6e], 0x14: [0x37, 0xde, 0x5a],
  0x15: [0x3c, 0xeb, 0x50], 0x16: [0x28, 0xe2, 0x14], 0x17: [0x7d, 0xc1, 0x3d], 0x18: [0x8c, 0xc8, 0x32],
  0x19: [0x9b, 0xd7, 0x23], 0x1a: [0xa5, 0xe1, 0x16], 0x1b: [0xa5, 0xdc, 0x0a], 0x1c: [0xaa, 0xd2, 0x08],
  0x1d: [0xb4, 0xc8, 0x05], 0x1e: [0xb4, 0xbe, 0x04], 0x1f: [0xba, 0xb4, 0x04], 0x20: [0xc3, 0xaf, 0x04],
  0x21: [0xe1, 0xaa, 0x00], 0x22: [0xff, 0xa0, 0x00], 0x23: [0xff, 0x96, 0x00], 0x24: [0xff, 0x8c, 0x00],
  0x25: [0xff, 0x75, 0x00], 0x26: [0xe0, 0x64, 0x1b], 0x27: [0xe0, 0x46, 0x1e], 0x28: [0xe0, 0x30, 0x1e],
  0x29: [0xe0, 0x28, 0x23], 0x2a: [0xe6, 0x28, 0x28], 0x2b: [0xff, 0x37, 0x6f], 0x2c: [0xff, 0x2d, 0x6f],
  0x2d: [0xff, 0x12, 0x7b], 0x2e: [0xf5, 0x1e, 0x8c], 0x2f: [0xeb, 0x2d, 0xa0], 0x30: [0xe6, 0x37, 0xb4],
  0x31: [0xde, 0x44, 0xcf], 0x32: [0xde, 0x44, 0x8d], 0x33: [0xe6, 0x30, 0xb4], 0x34: [0xe6, 0x19, 0xdc],
  0x35: [0xe6, 0x00, 0xff], 0x36: [0xdc, 0x00, 0xff], 0x37: [0xcc, 0x00, 0xff], 0x38: [0xb4, 0x32, 0xff],
  0x39: [0xb9, 0x3c, 0xff], 0x3a: [0xc5, 0x42, 0xff], 0x3b: [0xaa, 0x5a, 0xff], 0x3c: [0xaa, 0x72, 0xff],
  0x3d: [0x82, 0x72, 0xff], 0x3e: [0x64, 0x73, 0xff]
});

function buildRmst(requestingPlayer, menuId, slot, trackType) {
  return ((requestingPlayer & 0xff) << 24) | ((menuId & 0xff) << 16) | ((slot & 0xff) << 8) | (trackType & 0xff);
}

function nextTx(session) {
  session.tx = (session.tx || 0) + 1;
  return session.tx;
}

async function sendMessage(session, tx, type, args) {
  const tags = Buffer.alloc(12);
  args.forEach((arg, index) => {
    tags[index] = arg.argTag;
  });
  await writeAll(session.socket, Buffer.concat([
    numberField(MESSAGE_START, 4),
    numberField(tx, 4),
    numberField(type, 2),
    numberField(args.length, 1),
    binaryField(tags),
    ...args.map((arg) => arg.bytes)
  ]));
}

async function readMessage(session) {
  const start = await readField(session);
  if (start.kind !== 'number' || start.value !== MESSAGE_START) throw new Error('Invalid dbserver message start');
  const tx = await readField(session);
  const type = await readField(session);
  const count = await readField(session);
  const argTypes = await readField(session);
  const tags = argTypes.value.subarray(0, count.value);
  const args = [];
  let last = null;

  for (const tag of tags) {
    let field;
    if (tag === 3 && last?.kind === 'number' && last.value === 0) field = {kind: 'binary', value: Buffer.alloc(0), argTag: 3};
    else field = await readField(session);
    args.push(field);
    last = field;
  }

  return {tx: tx.value, type: type.value, args};
}

async function readField(session) {
  const tag = (await session.reader.readExact(1))[0];
  if (tag === 0x0f) return {kind: 'number', value: (await session.reader.readExact(1)).readUInt8(0), argTag: 6};
  if (tag === 0x10) return {kind: 'number', value: (await session.reader.readExact(2)).readUInt16BE(0), argTag: 6};
  if (tag === 0x11) return {kind: 'number', value: (await session.reader.readExact(4)).readUInt32BE(0), argTag: 6};
  if (tag === 0x14) {
    const size = (await session.reader.readExact(4)).readUInt32BE(0);
    return {kind: 'binary', value: await session.reader.readExact(size), argTag: 3};
  }
  if (tag === 0x26) {
    const chars = (await session.reader.readExact(4)).readUInt32BE(0);
    const bytes = await session.reader.readExact(chars * 2);
    return {kind: 'string', value: decodeUtf16Be(bytes.subarray(0, Math.max(0, bytes.length - 2))), argTag: 2};
  }
  throw new Error(`Unknown dbserver field tag 0x${tag.toString(16)}`);
}

function readUInt16LE(bytes, offset) {
  return bytes.length >= offset + 2 ? bytes.readUInt16LE(offset) : 0;
}

function readUInt32LE(bytes, offset) {
  return bytes.length >= offset + 4 ? bytes.readUInt32LE(offset) : 0;
}

function numberArg(value, size = 4) {
  return {argTag: 6, bytes: numberField(value, size)};
}

function numberField(value, size) {
  const buffer = Buffer.alloc(size + 1);
  buffer[0] = size === 1 ? 0x0f : size === 2 ? 0x10 : 0x11;
  if (size === 1) buffer.writeUInt8(value & 0xff, 1);
  else if (size === 2) buffer.writeUInt16BE(value & 0xffff, 1);
  else buffer.writeUInt32BE(value >>> 0, 1);
  return buffer;
}

function binaryField(bytes) {
  if (!bytes.length) return Buffer.alloc(0);
  const buffer = Buffer.alloc(bytes.length + 5);
  buffer[0] = 0x14;
  buffer.writeUInt32BE(bytes.length, 1);
  bytes.copy(buffer, 5);
  return buffer;
}

function decodeUtf16Be(bytes) {
  const swapped = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1] || 0;
    swapped[index + 1] = bytes[index] || 0;
  }
  return swapped.toString('utf16le');
}

function makeReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  socket.on('error', rejectAll);
  socket.on('close', () => rejectAll(new Error('dbserver socket closed')));

  function flush() {
    while (waiters.length && buffer.length >= waiters[0].size) {
      const waiter = waiters.shift();
      const out = buffer.subarray(0, waiter.size);
      buffer = buffer.subarray(waiter.size);
      waiter.resolve(out);
    }
  }

  function rejectAll(error) {
    while (waiters.length) waiters.shift().reject(error);
  }

  return {
    readExact(size) {
      if (buffer.length >= size) {
        const out = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        return Promise.resolve(out);
      }
      return new Promise((resolve, reject) => {
        waiters.push({size, resolve, reject});
      });
    }
  };
}

function onceConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('dbserver connection timeout')));
  });
}

function writeAll(socket, buffer) {
  return new Promise((resolve, reject) => {
    socket.write(buffer, (error) => error ? reject(error) : resolve());
  });
}

module.exports = {
  requestTrackData,
  requestTrackCues,
  queryDbServerPort,
  parseMetadataItems,
  decodeBlueWaveformPreview,
  decodeRgbWaveformPreview,
  decodeThreeBandWaveformPreview,
  decodeBlueWaveformDetail,
  decodeRgbWaveformDetail,
  decodeThreeBandWaveformDetail,
  decodeBeatGrid,
  decodeLegacyCueList,
  decodeExtendedCueList,
  decodeAlbumArt,
  decodeUtf16Be,
  buildRmst
};
