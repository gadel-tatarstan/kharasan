export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const fmtMm = (mm: number): string => {
  const rounded = Math.round(mm);
  return rounded.toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
};

export const fmtM2 = (mm2: number): string => {
  const v = mm2 / 1e6;
  const digits = v < 1 ? 3 : 2;
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

/** Compact metres for the scene footprint, e.g. 4,6 × 12,35. */
export const fmtSize = (mm: number): string =>
  (mm / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

export const fmtM3 = (mm3: number): string => {
  const v = mm3 / 1e9;
  const digits = v < 0.1 ? 3 : 2;
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

export const parseNum = (raw: string, signed = false): number | null => {
  const cleaned = raw
    .replace(/\s/g, '')
    .replace(/\u2212/g, '-')
    .replace(',', '.')
    .replace(signed ? /[^\d.-]/g : /[^\d.]/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '-') return null;
  const v = Number.parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  return v;
};

/** Concrete often ships in 0.1 m³ steps but we keep 0.01 for accuracy. */
export const m3Value = (mm3: number) => mm3 / 1e9;
