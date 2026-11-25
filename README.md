# Moj Novi Sad — Transkript

A browser editor for transcripts made with the Offline Transcriber phone app. You open the phone's bundle
(`<title> - editor.zip`), listen to the recording, correct the text, optionally run it past an AI chat
for correction, and save a bundle to take back to the phone. Every change is kept as a numbered version.

**Your files stay on your computer.** The page makes no requests to other servers: a strict Content
Security Policy forbids them. Transcripts and recordings are kept only in this browser's storage. Once
loaded, the editor also works offline and can be installed as an app.

Plain static files, with no build step and no dependencies. To run it locally:

    python3 -m http.server 8080      # then open http://localhost:8080/

The branding (logo and colours) is from https://www.mojnovisad.com/ and is used with the owner's permission.
