# Audio Transcription

Audio Transcription is a Chrome extension that allows users to capture any audio playing on the current tab and transcribe it using OpenAI-whisper in real time. Users will have the option to do voice activity detection as well to not send audio to server when there is no speech.

We use OpenAI-whisper model to process the audio continuously and send the transcription back to the client. We apply a few optimizations on top of OpenAI's implementation to improve performance and run it faster in a real-time manner. To this end, we used [faster-whisper](https://github.com/guillaumekln/faster-whisper) which is 4x faster than OpenAI's implementation.

## Loading the Extension
- Open the Google Chrome browser.
- Type chrome://extensions in the address bar and press Enter.
- Enable the Developer mode toggle switch located in the top right corner.
- Clone this repository
- Click the Load unpacked button.
- Browse to the location where you cloned the repository files and select the ```Audio Transcription``` folder.
- The extension should now be loaded and visible on the extensions page.


## Real time transcription with OpenAI-whisper
This Chrome extension allows you to send audio from your browser to a server for transcribing the audio in real time. It can also incorporate voice activity detection on the client side to detect when speech is present, and it continuously receives transcriptions of the spoken content from the server. You can select from the options menu if you want to run the speech recognition.


## Implementation Details

### Capturing Audio
To capture the audio in the current tab, we used the chrome `tabCapture` API to obtain a `MediaStream` object of the current tab.

### Options
When using the Audio Transcription extension, you have the following options:
 - **WhisperLive server / Port**: Defaults to `localhost:9090`. Audio is sent only to this configured server. Enter a hostname without a scheme; an empty port uses `wss://HOST/ws`, otherwise `ws://HOST:PORT/`.
 - **Language**: Select the target language for transcription or translation. You can choose from a variety of languages supported by OpenAI-whisper.
 - **Download SRT file at Stop Capture**: Select if you want to download the srt file for the session at stop capture.
 - **Task:** Choose the specific task to perform on the audio. You can select either "transcribe" for transcription or "translate" to translate the audio to English.
 - **Model Size**: Select the whisper model size to run the server with.

### Getting Started
- Make sure the transcription server is running properly. To know more about how to start the server, see the [documentation here](https://github.com/collabora/whisper-live).
- Just click on the Chrome Extension which should show 2 options
  - **Start Capture** : Starts capturing the audio in the current tab and sends the captured audio to the server for transcription. This also creates an element to show the transcriptions recieved from the server on the current tab.
  - **Stop Capture** - Stops capturing the audio.


## Limitations
The extension requires a reachable WhisperLive server; a local server does not require an internet connection. The accuracy of the transcriptions may vary depending on the audio quality and the performance of the server-side transcription service. The extension may consume additional system resources while running, especially when streaming audio.

## Mention notifications

The popup provides a mention detector switch, an independent sound switch, a watch-word editor, and the last detected snippet with its local timestamp. Defaults are `Вячеслав`, `Слав`, and `Слава`. Settings and the last mention are saved in `chrome.storage.local`; detector changes apply during capture, even after closing the popup.

Text matching ignores case, punctuation, repeated whitespace and the distinction between `ё` and `е`. Matching uses whole words and phrases, with common Russian singular name inflections and short vocatives such as `Серёж` for `Серёжа`. It does not use arbitrary prefix matching: `Слав` does not match `славянский`. This is a bounded inflection heuristic, not a full morphological dictionary; add unusual forms or nicknames explicitly to the watch list.

Both partial and committed WebSocket segments are checked immediately. Updates of a previously matched segment are suppressed using its numeric start timestamp and overlapping audio intervals, including timestamp revisions. There is a global 20-second cooldown; mentions suppressed during cooldown do not reappear when the segment is replayed later. Detection state resets for each capture.

Notifications show `Тебя упомянули` and the original transcript snippet. System notification sound is silenced to avoid duplicate chimes. An independent short tone is generated locally with Web Audio in the recorder page and connected directly to playback, outside the audio path sent to WhisperLive. No remote audio assets, analytics, or additional services are used. Chrome notifications must be allowed in macOS System Settings for banners to appear.

Configured watch words are sent as `hotwords` in the existing WhisperLive connection handshake. Supported servers/backends (including faster-whisper) use these hints; detector settings apply immediately, while hotword changes take effect on the next capture. Use Russian transcription rather than English translation to detect Russian names reliably.

## Architecture and transcript history

- `background.js`: starts/stops the recorder page and creates Chrome notifications.
- `options.js`: acquires only the requested tab via `chrome.tabCapture.getMediaStreamId` with explicit `targetTabId` and recorder `consumerTabId`, processes its audio with the existing AudioWorklet, and handles the existing WhisperLive WebSocket stream. Changing the active tab does not redirect capture. Microphone and other tabs are not captured.
- `mentions.js`: normalization, watch-word forms, partial detection, segment deduplication, and cooldown.
- `transcript-history.js`: collects only segments with `completed: true`, independently of the SRT download option.
- `content.js`: renders live captions in the captured tab and optionally exports SRT.
- `popup.html` / `popup.js`: controls and persisted configuration; `manifest.json`: extension permissions including `notifications`.

The latest call is stored under `chrome.storage.local.transcriptHistory` as `{ sessionId, tabId, startedAt, endedAt, segments }`. Committed segments are deduplicated by their numeric start timestamp, sorted by audio time and saved throughout the call. A new capture replaces the latest-call history. Partial text never enters this history, even on Stop; optional SRT export retains its existing provisional-tail behavior.

Stop disconnects capture, sends binary `END_OF_AUDIO`, waits for final committed messages and server closure (up to five seconds), then saves the ended history before closing the recorder. Servers that do not finalize the tail leave it out of the committed history. The history module and final snapshot form the future summary integration point; summarization is intentionally not implemented.

## Verification

Run `npm install` and `npm test -- --runInBand` in `Audio-Transcription-Chrome`.

For a browser smoke test, load this directory unpacked in `chrome://extensions`, start a local WhisperLive server, choose Russian / Transcribe and open a tab playing a call or a recording. Start Capture, say `Вячеславу` or `Слава, посмотри billing`, and check the notification, tone, and last mention timestamp. Switch to another tab and verify capture remains attached to the original. Repeated partial updates should produce one alert; a fresh mention after 20 seconds should produce another. Toggle the detector and sound during capture, then stop and inspect `transcriptHistory` in extension storage. Repeat capture to verify session state resets.

## Note
The extension relies on a properly running transcription server with multilingual support. Please follow the server documentation for setup and configuration.
