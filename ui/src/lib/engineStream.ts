// JS mirror of extensions_built_in/inference_engine/protocol.py's binary
// frame format, referenced by that file's module docstring but missing from
// the upstream commit that added it (ostris/ai-toolkit PR #1039) — see
// FORK_NOTES.md's 2026-09-12 sync entry. Ported from the Python source of
// truth, not guessed: the frame layout below is protocol.py's `encode_frame`/
// `FrameReader`, and the latent -> RGB preview math is ComfyUI's own
// `Latent2RGBPreviewer` (`(projected + 1) / 2` clamped to `[0, 1]`, then
// scaled to `0..255`), which is what latent_format_tables.py's factors/bias
// tables were fit against.
//
// One generation request is answered with a chunked HTTP body made of frames:
//
//   u32 header_len (little endian) | json header (utf-8) |
//   u64 payload_len (little endian) | payload bytes
//
// Frame `header.type`: start / status / progress / latent / result / error / end.
// See protocol.py for the full list and per-type fields.

export interface EngineFrame {
  header: any;
  payload: Uint8Array;
}

export interface PreviewInfo {
  format: string;
  channels: number;
  dims: 2 | 3;
  spatial: number;
  temporal: number;
  reshape: string | null;
  factors: number[][];
  bias: number[] | null;
}

export interface LatentImage {
  width: number;
  height: number;
  frames: number;
  // one RGBA buffer per frame, width * height * 4 bytes, ready for `new ImageData(...)`
  frameData: Uint8ClampedArray[];
}

const HEADER_LEN_BYTES = 4; // u32
const PAYLOAD_LEN_BYTES = 8; // u64

/**
 * Reads engine frames out of a fetch Response's streaming body and invokes
 * `onFrame` for each one, in order, as soon as it is fully buffered.
 * Resolves once the stream ends or `signal` aborts.
 */
export async function readEngineFrames(res: Response, onFrame: (frame: EngineFrame) => void, signal?: AbortSignal): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let buf = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  };
  const consume = (n: number) => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const fillTo = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value && value.length) append(value);
    }
    return true;
  };

  try {
    while (true) {
      if (!(await fillTo(HEADER_LEN_BYTES))) return;
      const hlen = new DataView(buf.buffer, buf.byteOffset, HEADER_LEN_BYTES).getUint32(0, true);
      if (!(await fillTo(HEADER_LEN_BYTES + hlen + PAYLOAD_LEN_BYTES))) return;
      consume(HEADER_LEN_BYTES);
      const headerBytes = consume(hlen);
      const header = JSON.parse(new TextDecoder('utf-8').decode(headerBytes));
      const plenBytes = consume(PAYLOAD_LEN_BYTES);
      const plen = Number(new DataView(plenBytes.buffer, plenBytes.byteOffset, PAYLOAD_LEN_BYTES).getBigUint64(0, true));
      if (!(await fillTo(plen))) return;
      const payload = consume(plen).slice();
      onFrame({ header, payload });
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function float16ToFloat32(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exponent = (h & 0x7c00) >> 10;
  const fraction = h & 0x03ff;
  let value: number;
  if (exponent === 0) {
    value = Math.pow(2, -14) * (fraction / 1024);
  } else if (exponent === 0x1f) {
    value = fraction ? NaN : Infinity;
  } else {
    value = Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }
  return sign ? -value : value;
}

/** Decode a `latent` frame's raw payload to a flat, row-major Float32Array. */
export function payloadToFloat32(header: any, payload: Uint8Array): Float32Array {
  const dtype = header?.dtype || 'float16';
  if (dtype === 'float16') {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const n = payload.byteLength / 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = float16ToFloat32(view.getUint16(i * 2, true));
    }
    return out;
  }
  // float32 (or anything else): reinterpret as little-endian float32. `payload`
  // is a freshly-sliced buffer (see readEngineFrames), so it's 4-byte aligned.
  return new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
}

/**
 * Turn a decoded latent tensor into a rough RGB(A) preview, per-pixel linear
 * projection à la ComfyUI's `Latent2RGBPreviewer` — no VAE decode. `data` is
 * the tensor from `payloadToFloat32`, contiguous in the shape the `latent`
 * frame's header describes (batch dim already trimmed to 1 server-side).
 * Returns null when there's no preview table yet, or it doesn't match this
 * tensor's channel count (e.g. a stale table from a previous job).
 */
export function latentToImage(header: any, data: Float32Array, preview: PreviewInfo | null): LatentImage | null {
  if (!preview || !preview.factors || !preview.factors.length) return null;
  const shape: number[] | undefined = header?.shape;
  const layout = header?.layout;
  if (!Array.isArray(shape)) return null;

  let frames: number, height: number, width: number;
  if (layout === 'BCFHW' && shape.length === 5) {
    [, , frames, height, width] = shape;
  } else if (layout === 'BCHW' && shape.length === 4) {
    frames = 1;
    [, , height, width] = shape;
  } else {
    return null;
  }
  const channels = shape[1];
  if (channels !== preview.channels) return null;

  const factors = preview.factors;
  const bias = preview.bias || [0, 0, 0];
  const hw = height * width;
  const frameData: Uint8ClampedArray[] = [];
  for (let f = 0; f < frames; f++) {
    const out = new Uint8ClampedArray(hw * 4);
    const frameBase = layout === 'BCFHW' ? f * hw : 0;
    const channelStride = layout === 'BCFHW' ? frames * hw : hw;
    for (let p = 0; p < hw; p++) {
      let r = bias[0];
      let g = bias[1];
      let b = bias[2];
      for (let c = 0; c < channels; c++) {
        const v = data[c * channelStride + frameBase + p];
        const fc = factors[c];
        r += v * fc[0];
        g += v * fc[1];
        b += v * fc[2];
      }
      const o = p * 4;
      out[o] = Math.min(1, Math.max(0, (r + 1) / 2)) * 255;
      out[o + 1] = Math.min(1, Math.max(0, (g + 1) / 2)) * 255;
      out[o + 2] = Math.min(1, Math.max(0, (b + 1) / 2)) * 255;
      out[o + 3] = 255;
    }
    frameData.push(out);
  }
  return { width, height, frames, frameData };
}
