// Which speech model the browser downloads. Pinned to a revision, so a change on Hugging Face cannot change the
// transcripts (or the download) without a release of the editor.
export const MODEL = 'onnx-community/whisper-large-v3-turbo';
export const REVISION = '360ebcde2559d60bb474678be3c1de9ef347d01a';
// 25 Nov 2026: q4f16 for both parts (~540 MB) ran at 0.7-0.9x the audio length on Iris Xe graphics.
export const DTYPE = { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' };
/** Shown before the first download. */
export const DOWNLOAD_MB = 540;
/** The two large files; the model counts as downloaded when both are stored. */
export const BIG_FILES = ['encoder_model_q4f16.onnx', 'decoder_model_merged_q4f16.onnx'];
/** What the transcript records as its engine. */
export const ENGINE = 'whisper-large-v3-turbo q4f16 · WebGPU';
