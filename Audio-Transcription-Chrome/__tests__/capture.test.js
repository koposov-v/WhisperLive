const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('util');

function loadScript(context, file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}

function recorder(settings = {}) {
  const storage = { ...settings };
  const oscillator = { frequency: { setValueAtTime: jest.fn() }, connect: jest.fn(), disconnect: jest.fn(), start: jest.fn(), stop: jest.fn() };
  const gain = { gain: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() }, connect: jest.fn(), disconnect: jest.fn() };
  const track = { stop: jest.fn() };
  const stream = { getTracks: () => [track] };
  const context = vm.createContext({
    console, setTimeout, clearTimeout, TextEncoder,
    navigator: { mediaDevices: { getUserMedia: jest.fn(async () => stream) } },
    chrome: {
      runtime: {
        getURL: file => `chrome-extension://test/${file}`,
        onMessage: { addListener: jest.fn() }, sendMessage: jest.fn(),
      },
      storage: {
        onChanged: { addListener: jest.fn() },
        local: {
          get: jest.fn((defaults, callback) => callback({ ...defaults, ...storage })),
          set: jest.fn((values, callback) => { Object.assign(storage, values); if (callback) callback(); }),
        },
      },
      tabs: { getCurrent: jest.fn(async () => ({ id: 99 })), sendMessage: jest.fn((tabId, message, callback) => callback({})) },
      tabCapture: { getMediaStreamId: jest.fn((options, callback) => callback('tab-stream')) },
    },
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
        this.audioWorklet = { addModule: jest.fn(async () => {}) };
      }
      createMediaStreamSource() { return { connect: jest.fn() }; }
      createOscillator() { return oscillator; }
      createGain() { return gain; }
      close() { return Promise.resolve(); }
    },
    AudioWorkletNode: class {
      constructor() { this.port = {}; }
      connect() {}
      disconnect() {}
    },
  });
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.send = jest.fn();
      Socket.instance = this;
    }
    close() {
      this.readyState = Socket.CLOSED;
      this.onclose();
    }
  }
  context.WebSocket = Socket;
  ['mentions.js', 'transcript-history.js', 'options.js'].forEach(file => loadScript(context, file));
  const start = async () => {
    await context.startRecord({ currentTabId: 42, host: 'localhost', port: '9090', language: null, task: 'transcribe', modelSize: 'small', saveCaptions: false });
    const socket = Socket.instance;
    socket.readyState = Socket.OPEN;
    socket.onopen();
    const handshake = JSON.parse(socket.send.mock.calls[0][0]);
    const receive = data => socket.onmessage({ data: JSON.stringify({ uid: handshake.uid, ...data }) });
    await receive({ message: 'SERVER_READY' });
    return { socket, handshake, receive };
  };
  return { context, storage, start, oscillator, gain, track };
}

test('captures only specified tab and supplies dynamically configured hotwords', async () => {
  const harness = recorder({ watchWords: ['Серёжа', 'billing'] });
  const { socket, handshake } = await harness.start();
  expect(harness.context.chrome.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42, consumerTabId: 99 }, expect.any(Function));
  expect(harness.context.navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'tab-stream' } }, video: false,
  });
  expect(socket.url).toBe('ws://localhost:9090/');
  expect(handshake.hotwords).toBe('Серёжа, billing');
});

test('first partial with detected language immediately notifies and plays local sound without entering history', async () => {
  const harness = recorder();
  const { receive } = await harness.start();
  await receive({ language: 'ru', segments: [{ start: 0, end: 3, text: 'Слава, можешь посмотреть billing?', completed: false }] });
  expect(harness.context.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'mentionDetected', mention: expect.objectContaining({ text: 'Слава, можешь посмотреть billing?' }) }));
  expect(harness.oscillator.start).toHaveBeenCalledTimes(1);
  expect(harness.gain.connect).toHaveBeenCalledWith(expect.any(Object));
  expect(harness.storage.transcriptHistory.segments).toHaveLength(0);
  await receive({ segments: [{ start: 0, end: 4, text: 'Слава, можешь посмотреть billing, пожалуйста?', completed: true }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(harness.storage.transcriptHistory.segments).toHaveLength(1);
  expect(harness.oscillator.start).toHaveBeenCalledTimes(1);
});

test('runtime settings disable detection and sound independently', async () => {
  const harness = recorder();
  const { receive } = await harness.start();
  const update = harness.context.chrome.storage.onChanged.addListener.mock.calls[0][0];
  update({ mentionEnabled: { newValue: false } }, 'local');
  await receive({ segments: [{ start: 0, end: 1, text: 'Слава' }] });
  expect(harness.storage.lastMention).toBeUndefined();
  update({ mentionEnabled: { newValue: true }, mentionSound: { newValue: false }, watchWords: { newValue: ['billing'] } }, 'local');
  await receive({ segments: [{ start: 2, end: 3, text: 'billing' }] });
  expect(harness.storage.lastMention.text).toBe('billing');
  expect(harness.oscillator.start).not.toHaveBeenCalled();
});

test('Stop sends binary END_OF_AUDIO, receives committed tail and persists history before replying', async () => {
  const harness = recorder();
  const { socket, receive } = await harness.start();
  socket.send.mockImplementation(frame => {
    if (typeof frame !== 'string') {
      expect(Buffer.from(frame).toString()).toBe('END_OF_AUDIO');
      receive({ segments: [{ start: 0, end: 2, text: 'финальный текст', completed: true }] });
      socket.close();
    }
  });
  await harness.context.stopRecord();
  expect(harness.track.stop).toHaveBeenCalled();
  expect(harness.storage.transcriptHistory.endedAt).not.toBeNull();
  expect(harness.storage.transcriptHistory.segments[0].text).toBe('финальный текст');
});

test('background notification contains required title and original snippet', () => {
  const context = vm.createContext({
    chrome: {
      runtime: { getURL: file => `chrome-extension://test/${file}`, onMessage: { addListener: jest.fn() } },
      notifications: { create: jest.fn((id, notification, callback) => callback()) },
    },
  });
  loadScript(context, 'background.js');
  const listener = context.chrome.runtime.onMessage.addListener.mock.calls[0][0];
  listener({ action: 'mentionDetected', sessionId: 'session', mention: { segmentStart: 1, text: 'Серёж, можешь посмотреть billing?' } }, { url: 'chrome-extension://test/options.html' }, jest.fn());
  expect(context.chrome.notifications.create).toHaveBeenCalledWith('mention-session-1', expect.objectContaining({
    title: 'Тебя упомянули', message: 'Серёж, можешь посмотреть billing?', type: 'basic', silent: true,
  }), expect.any(Function));
});
