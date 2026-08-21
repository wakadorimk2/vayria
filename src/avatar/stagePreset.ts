export const STAGE_PRESET = {
  backgroundColor: '#242633',
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
      intensity: 0.25,
    },
    key: {
      color: '#fff0e6',
      intensity: 0.55,
      position: [1.5, 2.2, 2.5],
    },
    fill: {
      color: '#dce7ff',
      intensity: 0.1,
      position: [-1.5, 1.4, 1.8],
    },
    back: {
      color: '#d9c8ff',
      intensity: 0.12,
      position: [0.5, 2, -2],
    },
  },
} as const;
