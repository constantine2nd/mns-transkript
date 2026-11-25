# Third-party files

Served as they are, not changed. They are used only by the in-browser transcription (`asr-worker.js`).

| File | Package | Version | License |
|---|---|---|---|
| `transformers.min.js` | [@huggingface/transformers](https://github.com/huggingface/transformers.js) | 3.8.1 | Apache-2.0 (`LICENSE-transformers.js.txt`) |
| `ort/ort-wasm-simd-threaded.jsep.mjs`, `ort/ort-wasm-simd-threaded.jsep.wasm` | [onnxruntime-web](https://github.com/microsoft/onnxruntime) (bundled with the above) | 1.22.0-dev.20250409-89f8206ba4 | MIT, Copyright (c) Microsoft Corporation |

The speech model itself is not in this repository. The browser downloads it once from Hugging Face
([onnx-community/whisper-large-v3-turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo), revision
`360ebcde2559d60bb474678be3c1de9ef347d01a`, OpenAI Whisper, MIT) and keeps it in the browser's private file storage.

To update: `npm i @huggingface/transformers@<version> --ignore-scripts` in a scratch folder and copy
`dist/transformers.min.js` and onnxruntime-web's `dist/ort-wasm-simd-threaded.jsep.{mjs,wasm}` here.
