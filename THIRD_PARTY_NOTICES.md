# Third-party notices

Vayria uses the following open-source projects as dependencies or reference
implementations.

## AITuber OnAir

- Source: https://github.com/shinshin86/aituber-onair
- License: MIT
- Usage: The official VRM starter informed the Vite/React structure, VRM
  loading, and audio-volume lip-sync approach. Vayria uses the published
  `@aituber-onair/chat` and `@aituber-onair/voice` packages.

The Miko VRM and VRMA files are not distributed with Vayria.

## three.js and @pixiv/three-vrm

- three.js: https://github.com/mrdoob/three.js — MIT License
- @pixiv/three-vrm: https://github.com/pixiv/three-vrm — MIT License
- @pixiv/three-vrm-animation: https://github.com/pixiv/three-vrm — MIT License

## NVIDIA ARDY integration boundary

Vayria does not vendor NVIDIA ARDY source or model weights.

- ARDY source: https://github.com/nv-tlabs/ardy — Apache-2.0
- ARDY model checkpoints: NVIDIA Open Model License / Agreement terms apply
- NVIDIA Open Model License: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- Text-To-VRMA reference: https://github.com/Kirakun0328/text-to-vrma — MIT License

The ARDY commit, model ID, download source, and applicable model notice must be
recorded when a checkpoint is used to generate a curated VRMA. Model weights
remain outside the repository.
