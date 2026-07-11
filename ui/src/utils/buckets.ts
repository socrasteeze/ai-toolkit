// Fork-only file (see FORK_NOTES.md). TypeScript port of toolkit/buckets.py
// get_bucket_for_image_size — must stay behaviorally identical so the UI's dataset
// analysis predicts the exact buckets the trainer will build. divisibility maps to the
// dataset's bucket_tolerance (default 64, toolkit/config_modules.py).

export interface BucketResolution {
  width: number;
  height: number;
}

export const getBucketForImageSize = (
  width: number,
  height: number,
  resolution: number = 512,
  divisibility: number = 8,
): BucketResolution => {
  const totalPixels = width * height;
  const maxPixels = resolution * resolution;

  const targetPixels = Math.min(totalPixels, maxPixels);

  const scaler = Math.sqrt(targetPixels / totalPixels);
  const wRaw = (width * scaler) / divisibility;
  const hRaw = (height * scaler) / divisibility;

  const candidates: [number, number][] = [
    [Math.floor(wRaw) * divisibility, Math.floor(hRaw) * divisibility],
    [Math.floor(wRaw) * divisibility, Math.ceil(hRaw) * divisibility],
    [Math.ceil(wRaw) * divisibility, Math.floor(hRaw) * divisibility],
    [Math.ceil(wRaw) * divisibility, Math.ceil(hRaw) * divisibility],
  ];
  let capped = candidates.filter(([w, h]) => w > 0 && h > 0 && w * h <= maxPixels);
  if (capped.length === 0) {
    capped = [
      [
        Math.max(divisibility, Math.floor(wRaw) * divisibility),
        Math.max(divisibility, Math.floor(hRaw) * divisibility),
      ],
    ];
  }

  let best = capped[0];
  let bestDiff = Math.abs(best[0] * best[1] - targetPixels);
  for (const wh of capped.slice(1)) {
    const diff = Math.abs(wh[0] * wh[1] - targetPixels);
    if (diff < bestDiff) {
      best = wh;
      bestDiff = diff;
    }
  }

  return { width: best[0], height: best[1] };
};
