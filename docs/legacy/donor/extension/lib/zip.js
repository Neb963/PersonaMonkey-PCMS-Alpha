import { ZIP_DEFAULT_LIMITS, ZIP_PATH_MAX_CHARS } from "./package-limits.js";
const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_CENTRAL = 0x06054b50;
const UTF8_FLAG = 0x0800;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return encoder.encode(String(value ?? ""));
}

function normalizeArchivePath(value) {
  const name = String(value || "");
  if (!name || name.length > ZIP_PATH_MAX_CHARS || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe ZIP path: ${name || "(empty)"}`);
  }
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe ZIP path: ${name}`);
  return parts.join("/");
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

export function crc32(value) {
  const bytes = asBytes(value);
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view, offset, value) { view.setUint16(offset, value, true); }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

export function createStoredZip(entries = [], limits = ZIP_DEFAULT_LIMITS) {
  const {
    maxCompressedBytes = ZIP_DEFAULT_LIMITS.maxCompressedBytes,
    maxEntries = ZIP_DEFAULT_LIMITS.maxEntries,
    maxEntryBytes = ZIP_DEFAULT_LIMITS.maxEntryBytes,
    maxUncompressedBytes = ZIP_DEFAULT_LIMITS.maxUncompressedBytes,
    maxPathBytes = ZIP_DEFAULT_LIMITS.maxPathBytes
  } = limits || {};
  if (!Array.isArray(entries) || !entries.length) throw new Error("ZIP requires at least one entry");
  if (entries.length > maxEntries) throw new Error("ZIP has too many entries");

  const seen = new Set();
  const prepared = entries.map((entry) => {
    const name = normalizeArchivePath(entry?.name);
    if (seen.has(name)) throw new Error(`Duplicate ZIP path: ${name}`);
    seen.add(name);
    const nameBytes = encoder.encode(name);
    if (nameBytes.byteLength > maxPathBytes) throw new Error(`ZIP path is too long: ${name}`);
    const data = asBytes(entry?.data);
    if (data.byteLength > maxEntryBytes) throw new Error(`ZIP entry is too large: ${name}`);
    return { name, nameBytes, data, crc: crc32(data), localOffset: 0 };
  });

  const totalData = prepared.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  if (totalData > maxUncompressedBytes) throw new Error("ZIP uncompressed payload is too large");

  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.nameBytes.byteLength + entry.data.byteLength, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.nameBytes.byteLength, 0);
  const archiveSize = localSize + centralSize + 22;
  if (archiveSize > maxCompressedBytes) throw new Error("ZIP archive exceeds the allowed compressed size");
  const out = new Uint8Array(archiveSize);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const entry of prepared) {
    entry.localOffset = offset;
    writeU32(view, offset, LOCAL_FILE);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, UTF8_FLAG);
    writeU16(view, offset + 8, 0);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, 0);
    writeU32(view, offset + 14, entry.crc);
    writeU32(view, offset + 18, entry.data.byteLength);
    writeU32(view, offset + 22, entry.data.byteLength);
    writeU16(view, offset + 26, entry.nameBytes.byteLength);
    writeU16(view, offset + 28, 0);
    offset += 30;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
    out.set(entry.data, offset);
    offset += entry.data.byteLength;
  }

  const centralOffset = offset;
  for (const entry of prepared) {
    writeU32(view, offset, CENTRAL_FILE);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 20);
    writeU16(view, offset + 8, UTF8_FLAG);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, 0);
    writeU16(view, offset + 14, 0);
    writeU32(view, offset + 16, entry.crc);
    writeU32(view, offset + 20, entry.data.byteLength);
    writeU32(view, offset + 24, entry.data.byteLength);
    writeU16(view, offset + 28, entry.nameBytes.byteLength);
    writeU16(view, offset + 30, 0);
    writeU16(view, offset + 32, 0);
    writeU16(view, offset + 34, 0);
    writeU16(view, offset + 36, 0);
    writeU32(view, offset + 38, 0);
    writeU32(view, offset + 42, entry.localOffset);
    offset += 46;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
  }

  writeU32(view, offset, END_CENTRAL);
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, prepared.length);
  writeU16(view, offset + 10, prepared.length);
  writeU32(view, offset + 12, centralSize);
  writeU32(view, offset + 16, centralOffset);
  writeU16(view, offset + 20, 0);
  return out;
}

function findEndRecord(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.byteLength - 65557);
  for (let offset = bytes.byteLength - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === END_CENTRAL) return offset;
  }
  throw new Error("Invalid ZIP: end record not found");
}

async function inflateRaw(bytes, maxOutputBytes, name) {
  if (typeof DecompressionStream !== "function") throw new Error("This runtime cannot decompress DEFLATE ZIP entries; use stored ZIP entries");
  let stream;
  try { stream = new DecompressionStream("deflate-raw"); }
  catch { throw new Error("This runtime cannot decompress raw DEFLATE ZIP entries; use stored ZIP entries"); }

  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = asBytes(value);
      total += chunk.byteLength;
      if (total > maxOutputBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`ZIP entry exceeds the allowed runtime size: ${name}`);
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readZip(input, limits = ZIP_DEFAULT_LIMITS) {
  const {
    maxCompressedBytes = ZIP_DEFAULT_LIMITS.maxCompressedBytes,
    maxEntries = ZIP_DEFAULT_LIMITS.maxEntries,
    maxEntryBytes = ZIP_DEFAULT_LIMITS.maxEntryBytes,
    maxUncompressedBytes = ZIP_DEFAULT_LIMITS.maxUncompressedBytes,
    maxPathBytes = ZIP_DEFAULT_LIMITS.maxPathBytes
  } = limits || {};
  const bytes = asBytes(input);
  if (bytes.byteLength > maxCompressedBytes) throw new Error("ZIP archive exceeds the allowed compressed size");
  if (bytes.byteLength < 22) throw new Error("Invalid ZIP: file is too small");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(bytes);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("Multi-disk ZIP archives are not supported");
  if (totalEntries < 1 || totalEntries > maxEntries) throw new Error("ZIP entry count is outside the allowed range");
  if (centralOffset + centralSize > bytes.byteLength) throw new Error("Invalid ZIP central directory");

  const entries = new Map();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_FILE) throw new Error("Invalid ZIP central file header");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 0x0001) throw new Error("Encrypted ZIP entries are not supported");
    if (![0, 8].includes(method)) throw new Error(`Unsupported ZIP compression method: ${method}`);
    if (uncompressedSize > maxEntryBytes) throw new Error("ZIP entry exceeds the allowed size");
    if (nameLength > maxPathBytes) throw new Error("ZIP filename exceeds the allowed length");
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error("Invalid ZIP filename length");
    const rawName = decoder.decode(bytes.slice(nameStart, nameEnd));
    const isDirectory = rawName.endsWith("/");
    const name = isDirectory
      ? `${normalizeArchivePath(rawName.slice(0, -1))}/`
      : normalizeArchivePath(rawName);
    if (entries.has(name)) throw new Error(`Duplicate ZIP path: ${name}`);
    cursor = nameEnd + extraLength + commentLength;
    if (cursor > centralOffset + centralSize) throw new Error("Invalid ZIP central directory bounds");

    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL_FILE) throw new Error(`Invalid local ZIP header for ${name}`);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localNameLength > maxPathBytes) throw new Error(`ZIP local filename exceeds the allowed length for ${name}`);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd > bytes.byteLength) throw new Error(`Invalid local ZIP filename length for ${name}`);
    const rawLocalName = decoder.decode(bytes.slice(localNameStart, localNameEnd));
    const localIsDirectory = rawLocalName.endsWith("/");
    const localName = localIsDirectory
      ? `${normalizeArchivePath(rawLocalName.slice(0, -1))}/`
      : normalizeArchivePath(rawLocalName);
    if (localName !== name || localFlags !== flags || localMethod !== method) throw new Error(`ZIP local/central header mismatch for ${name}`);
    // Streaming ZIP writers may defer these values when bit 3 is set; otherwise
    // the local header must agree with the central metadata used for parsing.
    if (!(flags & 0x0008) && (localCrc !== expectedCrc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) {
      throw new Error(`ZIP local/central size or checksum mismatch for ${name}`);
    }
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new Error(`Invalid ZIP data bounds for ${name}`);
    if (isDirectory) {
      if (compressedSize !== 0 || uncompressedSize !== 0) throw new Error(`ZIP directory entry contains data: ${name}`);
      continue;
    }

    let data;
    if (method === 0) {
      // Stored entries have no expansion step, so their actual runtime size is
      // the compressed byte count. Reject before copying the entry payload.
      if (compressedSize > maxEntryBytes) throw new Error(`ZIP entry exceeds the allowed runtime size: ${name}`);
      if (totalUncompressed + compressedSize > maxUncompressedBytes) throw new Error("ZIP uncompressed payload exceeds the allowed size");
      data = bytes.slice(dataStart, dataEnd);
    } else {
      const remainingTotal = Math.max(0, maxUncompressedBytes - totalUncompressed);
      const runtimeLimit = Math.min(maxEntryBytes, remainingTotal);
      data = await inflateRaw(bytes.subarray(dataStart, dataEnd), runtimeLimit, name);
    }
    if (data.byteLength !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP CRC mismatch for ${name}`);
    totalUncompressed += data.byteLength;
    if (totalUncompressed > maxUncompressedBytes) throw new Error("ZIP uncompressed payload exceeds the allowed size");
    entries.set(name, data);
  }
  return entries;
}

export function decodeZipText(value) {
  return decoder.decode(asBytes(value));
}
