import fs from 'fs';

// Fork-only file (see FORK_NOTES.md). Reads image dimensions from file headers without
// decoding pixels and without adding a dependency. Covers the dataset image whitelist
// (png/jpg/jpeg/webp — ui/src/server/datasetFiles.ts). Returns null for anything it
// can't parse; callers report those as "unreadable" rather than failing the scan.

export interface ImageDimensions {
  width: number;
  height: number;
}

const readBytes = async (handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer | null> => {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  if (bytesRead < length) return null;
  return buf;
};

const pngSize = async (handle: fs.promises.FileHandle): Promise<ImageDimensions | null> => {
  // 8-byte signature, 4-byte IHDR length, 4-byte "IHDR", then width/height as u32 BE
  const buf = await readBytes(handle, 0, 24);
  if (!buf) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

const jpegSize = async (handle: fs.promises.FileHandle): Promise<ImageDimensions | null> => {
  const head = await readBytes(handle, 0, 2);
  if (!head || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let pos = 2;
  // walk marker segments until a start-of-frame marker carries the dimensions
  for (let i = 0; i < 1000; i++) {
    const markerBuf = await readBytes(handle, pos, 4);
    if (!markerBuf) return null;
    if (markerBuf[0] !== 0xff) return null;
    const marker = markerBuf[1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      // standalone markers (no length)
      pos += 2;
      continue;
    }
    const segmentLength = markerBuf.readUInt16BE(2);
    if (segmentLength < 2) return null;
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const sof = await readBytes(handle, pos + 4, 5);
      if (!sof) return null;
      return { width: sof.readUInt16BE(3), height: sof.readUInt16BE(1) };
    }
    if (marker === 0xda) return null; // start of scan, no SOF seen — give up
    pos += 2 + segmentLength;
  }
  return null;
};

const webpSize = async (handle: fs.promises.FileHandle): Promise<ImageDimensions | null> => {
  const buf = await readBytes(handle, 0, 30);
  if (!buf) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const format = buf.toString('ascii', 12, 16);
  if (format === 'VP8X') {
    // canvas size: 24-bit LE minus one, at offsets 24/27
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
    };
  }
  if (format === 'VP8 ') {
    // lossy: dims at offset 26/28, 14 bits each
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === 'VP8L') {
    // lossless: 14-bit dims packed after the 0x2f signature byte
    const b = [buf[21], buf[22], buf[23], buf[24]];
    const width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    const height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
    return { width, height };
  }
  return null;
};

export const getImageDimensions = async (filePath: string): Promise<ImageDimensions | null> => {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (ext === '.png') return await pngSize(handle);
    if (ext === '.jpg' || ext === '.jpeg') return await jpegSize(handle);
    if (ext === '.webp') return await webpSize(handle);
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};
