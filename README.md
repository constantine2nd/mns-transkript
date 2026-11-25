# Moj Novi Sad — Transkript

A browser editor for transcripts made with the Offline Transcriber phone app. You open the phone's bundle
(`<title> - editor.zip`), listen to the recording, correct the text, optionally run it past an AI chat
for correction, and save a bundle to take back to the phone. Every change is kept as a numbered version.

It can also transcribe a recording itself ("Transkribuj snimak"), on the computer's graphics card (WebGPU, in
Chrome or Edge), with OpenAI's Whisper large-v3-turbo.

With your own Gemini API key (Podešavanja), the AI correction can also be sent to Gemini directly instead of
being copied into a chat.

**Your files stay on your computer.** The page makes no requests to other servers except Google's Gemini API,
and that only with your own key and only when you press "Pošalji Gemini-ju" (the transcript's text, never the
recording): a strict Content Security Policy forbids everything else. Transcripts and recordings are kept only in this browser's storage. The only
download from elsewhere is the speech model (about 540 MB), fetched once from Hugging Face when you first
transcribe, and kept in the browser; your recording is never sent anywhere. Once loaded, the editor also works
offline and can be installed as an app.

Third-party code: transformers.js (Apache-2.0) and ONNX Runtime Web (MIT), in `vendor/`.

Plain static files, with no build step and no dependencies. To run it locally:

    python3 -m http.server 8080      # then open http://localhost:8080/

The branding (logo and colours) is from https://www.mojnovisad.com/ and is used with the owner's permission.
