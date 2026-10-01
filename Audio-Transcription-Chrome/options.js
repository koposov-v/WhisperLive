/**
 * Captures audio from the active tab in Google Chrome.
 * @returns {Promise<MediaStream>} A promise that resolves with the captured audio stream.
 */
async function captureTabAudio(tabId) {
  const consumerTab = await chrome.tabs.getCurrent();
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId, consumerTabId: consumerTab.id }, streamId => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(streamId);
    });
  });
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
}


/**
 * Sends a message to a specific tab in Google Chrome.
 * @param {number} tabId - The ID of the tab to send the message to.
 * @param {any} data - The data to be sent as the message.
 * @returns {Promise<any>} A promise that resolves with the response from the tab.
 */
function sendMessageToTab(tabId, data) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, data, (response) => {
      resolve(response);
    });
  });
}

function generateUUID() {
  let dt = new Date().getTime();
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (dt + Math.random() * 16) % 16 | 0;
    dt = Math.floor(dt / 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return uuid;
}

// Global variables for audio processing
let audioContext = null;
let preNode = null;
let socket = null;
let isServerReady = false;
let currentStream = null;
let currentOptions = null;
let mentionDetector = null;
let transcriptHistory = null;
let historyWrites = Promise.resolve();
let stopping = false;
let stopPromise = null;
let resolveSocketClosed = null;
let recorderTabId = null;
chrome.tabs.getCurrent().then(tab => { recorderTabId = tab.id; });

function persistHistory() {
  const snapshot = transcriptHistory.snapshot();
  historyWrites = historyWrites.then(() => new Promise((resolve, reject) => {
    chrome.storage.local.set({ transcriptHistory: snapshot }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  })).catch(error => console.error('Transcript history could not be saved:', error));
  return historyWrites;
}

function finishHistory() {
  if (!transcriptHistory) return Promise.resolve();
  if (transcriptHistory.endedAt === null) transcriptHistory.endedAt = Date.now();
  return persistHistory();
}

async function playMentionSound() {
  if (!audioContext) return;
  try {
    const context = audioContext;
    if (context.state === 'suspended') await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;
    oscillator.frequency.setValueAtTime(880, start);
    oscillator.frequency.setValueAtTime(1174, start + 0.12);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.01);
    gain.gain.linearRampToValueAtTime(0, start + 0.28);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + 0.3);
  } catch (error) {
    console.error('Mention sound could not be played:', error);
  }
}

function processTranscript(segments) {
  if (!Array.isArray(segments)) return;
  if (transcriptHistory.commit(segments)) persistHistory();
  if (stopping) return;
  const mention = mentionDetector.detect(segments);
  if (!mention) return;
  chrome.storage.local.set({ lastMention: mention });
  chrome.runtime.sendMessage({ action: 'mentionDetected', sessionId: transcriptHistory.sessionId, mention });
  if (mentionDetector.settings.mentionSound) playMentionSound();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !mentionDetector) return;
  const settings = {};
  for (const key of Object.keys(Mentions.DEFAULT_SETTINGS)) {
    if (changes[key]) settings[key] = changes[key].newValue ?? Mentions.DEFAULT_SETTINGS[key];
  }
  mentionDetector.configure(settings);
});

function stopRecord() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    cleanupAudio();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const closed = new Promise(resolve => { resolveSocketClosed = resolve; });
      socket.send(new TextEncoder().encode('END_OF_AUDIO'));
      let timeout;
      await Promise.race([closed, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]);
      clearTimeout(timeout);
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    await finishHistory();
    return { stopped: true };
  })();
  return stopPromise;
}

// AudioWorklet URL - make sure this path matches your manifest.json
const WORKLET_URL = chrome.runtime.getURL('audiopreprocessor.js');

async function initAudioWorklet(stream) {
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  try {
    await audioContext.audioWorklet.addModule(WORKLET_URL);
    preNode = new AudioWorkletNode(audioContext, 'audiopreprocessor');
    const mediaStream = audioContext.createMediaStreamSource(stream);
    
    mediaStream.connect(preNode);
    preNode.connect(audioContext.destination);
    preNode.port.onmessage = (event) => {
      const data = event.data;
      
      
      const audio16k = data; // Float32Array @ 16 kHz
      
      if (socket && socket.readyState === WebSocket.OPEN && isServerReady) {
        socket.send(audio16k);
      }
    };
        
    // Test if we can hear audio (this will help verify the audio path)
    
  } catch (error) {
    console.error("Error initializing AudioWorklet:", error);
    throw error;
  }
}

function cleanupAudio() {
  
  if (preNode) {
    preNode.port.onmessage = null;
    preNode.disconnect();
    preNode = null;
  }
  
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (currentStream) {
    currentStream.oninactive = null;
    currentStream.getTracks().forEach(track => {
      track.stop();
      console.log("Stopped track:", track.kind);
    });
    currentStream = null;
  }
}

/**
 * Starts recording audio from the captured tab.
 * @param {Object} option - The options object containing the currentTabId.
 */
async function startRecord(option) {
  currentOptions = option;
  const uuid = generateUUID();
  const settings = await new Promise(resolve => chrome.storage.local.get(Mentions.DEFAULT_SETTINGS, resolve));
  mentionDetector = new Mentions.MentionDetector(settings);
  transcriptHistory = new TranscriptHistory(uuid, option.currentTabId);
  await persistHistory();
  const stream = await captureTabAudio(option.currentTabId);

  if (stream) {
    currentStream = stream;
    stream.oninactive = () => {
      chrome.runtime.sendMessage({ action: 'toggleCaptureButtons', saveCaptions: option.saveCaptions });
    };

    try {
      await initAudioWorklet(stream);
    } catch (error) {
      console.error("Failed to initialize AudioWorklet:", error);
      cleanupAudio();
      throw error;
    }

    const wsUrl = option.port
      ? `ws://${option.host}:${option.port}/`
      : `wss://${option.host}/ws`;
    socket = new WebSocket(wsUrl);
    isServerReady = false;
    let language = option.language;

    socket.onopen = function(e) {
      socket.send(
        JSON.stringify({
          uid: uuid,
          language: option.language,
          task: option.task,
          model: option.modelSize,
          use_vad: option.useVad,
          hotwords: Mentions.parseWatchWords(mentionDetector.settings.watchWords).join(', '),
        })
      );
    };

    socket.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        console.error('Invalid WhisperLive message:', error);
        return;
      }
      if (data["uid"] !== uuid)
        return;
      
      if (data["status"] === "WAIT"){
        await sendMessageToTab(option.currentTabId, {
          type: "showWaitPopup",
          data: data["message"],
        });
        chrome.runtime.sendMessage({ action: "toggleCaptureButtons", data: false }) 
        chrome.runtime.sendMessage({ action: "stopCapture" })
        return;
      }
        
      if (data.message === 'SERVER_READY') {
        isServerReady = true;
        return;
      }
      
      if (language == null && data.language) {
        language = data["language"];
        
        // send message to popup.js to update dropdown
        chrome.runtime.sendMessage({
          action: "updateSelectedLanguage",
          detectedLanguage: language,
        });

      }

      if (data["message"] === "DISCONNECT"){
        chrome.runtime.sendMessage({ action: "toggleCaptureButtons", data: false, saveCaptions: option.saveCaptions });        
        return;
      }

      if (data.status === 'ERROR') {
        chrome.runtime.sendMessage({ action: 'toggleCaptureButtons', saveCaptions: option.saveCaptions });
        return;
      }
      if (!Array.isArray(data.segments)) return;
      processTranscript(data.segments);

      const res = await sendMessageToTab(option.currentTabId, {
        type: "transcript",
        data: {
          data: event.data,
          saveCaptions: option.saveCaptions,
          captionLines: option.captionLines,
        },
      });
    };

    socket.onclose = () => {
      cleanupAudio();
      if (resolveSocketClosed) resolveSocketClosed();
      finishHistory();
      if (!stopping) chrome.runtime.sendMessage({ action: 'toggleCaptureButtons', saveCaptions: option.saveCaptions });
    };

    socket.onerror = (error) => {
      cleanupAudio();
      chrome.runtime.sendMessage({ action: 'toggleCaptureButtons', saveCaptions: option.saveCaptions });
    };

    return { started: true };

  } else {
    throw new Error('Tab audio capture returned no stream');
  }
}


/**
 * Listener for incoming messages from the extension's background script.
 * @param {Object} request - The message request object.
 * @param {Object} sender - The sender object containing information about the message sender.
 * @param {Function} sendResponse - The function to send a response back to the message sender.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, data } = request;
  if (request.recorderTabId !== recorderTabId) return false;

  switch (type) {
    case "start_capture":
      startRecord(data).then(sendResponse).catch(async error => {
        cleanupAudio();
        await finishHistory();
        console.error('Capture could not start:', error);
        sendResponse({ started: false, error: error.message });
      });
      return true;
    case "stop_capture":
      stopRecord().then(sendResponse);
      return true;
    default:
      return false;
  }
});
