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

## multicast-dns

- Package: `multicast-dns`
- Source: https://github.com/mafintosh/multicast-dns
- License: MIT
- Usage: Exhibition mode uses the pure-JavaScript mDNS client to advertise
  `vayria.local` only on the detected Windows Mobile Hotspot interface. The
  package is optional at runtime: an unavailable or conflicting mDNS socket
  leaves the dynamic hotspot-IP fallback available.
- Type definitions: `@types/multicast-dns` (MIT)

## three.js and @pixiv/three-vrm

- three.js: https://github.com/mrdoob/three.js — MIT License
- @pixiv/three-vrm: https://github.com/pixiv/three-vrm — MIT License
- @pixiv/three-vrm-animation: https://github.com/pixiv/three-vrm — MIT License

## MediaPipe Tasks Vision and Face Landmarker

- Package: `@mediapipe/tasks-vision` 1.0.1
- Source: https://github.com/google-ai-edge/mediapipe — Apache License 2.0
- Web API documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js
- Local WASM assets: `public/attention/wasm/`, copied from the npm package
- Model: Face Landmarker task bundle
- Model source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
- Model notice: MediaPipe Face Landmarker model assets are distributed under
  the applicable MediaPipe model terms and Apache License 2.0 notice.
- Local model asset: `public/attention/face_landmarker.task`
- Local model SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`

Vayria runs the Face Landmarker on the exhibition iPad. The camera frame stays
on the device. Vayria stores and sends only the normalized face position and
the application-level tracking availability.

## NVIDIA ARDY integration boundary

Vayria does not vendor NVIDIA ARDY source or model weights.

- ARDY source: https://github.com/nv-tlabs/ardy — Apache-2.0
- ARDY model checkpoints: NVIDIA Open Model License / Agreement terms apply
- NVIDIA Open Model License: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- Text-To-VRMA reference: https://github.com/Kirakun0328/text-to-vrma — MIT License

The ARDY commit, model ID, download source, and applicable model notice must be
recorded when a checkpoint is used to generate a curated VRMA. Model weights
remain outside the repository.
