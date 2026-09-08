export const STAGE_PRESET = {
  camera: {
    fov: 30,
    visibleHeightRatio: 0.48,
    topPaddingRatio: 0.06,
    distanceMultiplier: 1,
  },
  lighting: {
    hemisphere: {
      skyColor: '#fff4ea',
      groundColor: '#3a4056',
      intensity: 0.55,
    },
    key: {
      color: '#fff0e6',
      intensity: 1,
      position: [1.5, 2.2, 2.5],
    },
    fill: {
      color: '#dce7ff',
      intensity: 0.35,
      position: [-1.5, 1.4, 1.8],
    },
    back: {
      color: '#d9c8ff',
      intensity: 0.2,
      position: [0.5, 2, -2],
    },
  },
} as const;

// A neutral front fill keeps the face readable against the public pastel UI.
export const PUBLIC_STAGE_LIGHTING = {
  hemisphere: { skyColor: '#fff7f6', groundColor: '#afa2b5', intensity: 0.7 },
  key: { color: '#fff5ef', intensity: 0.8, position: [0.8, 1.8, 3] },
  fill: { color: '#f4eeff', intensity: 0.55, position: [-1.2, 1.5, 2.5] },
  back: { color: '#eed5f0', intensity: 0.16, position: [0.5, 2, -2] },
} as const;

export const CARD_PREVIEW_LIGHTING = {
  hemisphere: {
    skyColor: '#fff4ea',
    groundColor: '#3a4056',
    intensity: 0.45,
  },
  key: {
    color: '#fff0e6',
    intensity: 1.05,
    position: [1.5, 2.2, 2.5],
  },
  fill: {
    color: '#dce7ff',
    intensity: 0.25,
    position: [-1.5, 1.4, 1.8],
  },
  back: {
    color: '#d9c8ff',
    intensity: 0.2,
    position: [0.5, 2, -2],
  },
} as const;

export const EXHIBITION_PORTRAIT_CAMERA = {
  fov: 30,
  visibleHeightRatio: 0.36,
  topPaddingRatio: 0.08,
  distanceMultiplier: 1,
} as const;
