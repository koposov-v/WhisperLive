'use strict';

// ---------------------------------------------------------------------------
// Chrome API mock — defined before any extension script is loaded
// ---------------------------------------------------------------------------

const storageData = {};

global.chrome = {
  storage: {
    onChanged: { addListener: jest.fn() },
    local: {
      get: jest.fn((keys, cb) => {
        if (typeof keys === 'string') {
          cb({ [keys]: storageData[keys] });
        } else if (Array.isArray(keys)) {
          const result = {};
          keys.forEach(k => { result[k] = storageData[k]; });
          cb(result);
        } else {
          const result = {};
          Object.keys(keys).forEach(k => {
            result[k] = k in storageData ? storageData[k] : keys[k];
          });
          cb(result);
        }
      }),
      set: jest.fn((obj, cb) => {
        Object.assign(storageData, obj);
        if (cb) cb();
      }),
    },
  },
  runtime: {
    sendMessage: jest.fn(),
    onMessage: { addListener: jest.fn() },
    getURL: jest.fn(path => `chrome-extension://fake-id/${path}`),
    id: 'fake-extension-id',
  },
  tabs: {
    query: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
    sendMessage: jest.fn(),
  },
  tabCapture: { getMediaStreamId: jest.fn() },
  scripting: { executeScript: jest.fn() },
};

// Flush all pending microtasks and one macrotask round so async click
// handlers (which await at least one Promise inside) complete fully.
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

function resetStorage() {
  Object.keys(storageData).forEach(k => delete storageData[k]);
}

function buildPopupDOM() {
  document.body.innerHTML = `
    <button id="startCapture"></button>
    <button id="stopCapture"></button>
    <p id="captureStatus"></p>
    <input id="serverHost" value="localhost">
    <input id="serverPort" value="9090">
    <input type="checkbox" id="mentionEnabled">
    <input type="checkbox" id="mentionSound">
    <textarea id="watchWords"></textarea>
    <span id="lastMentionText"></span><time id="lastMentionTime"></time>
    <input type="checkbox" id="useVadCheckbox">
    <input type="checkbox" id="saveCaptionsCheckbox">
    <select id="languageDropdown">
      <option value="" selected></option>
      <option value="en">English</option>
    </select>
    <select id="taskDropdown">
      <option value="transcribe" selected>Transcribe</option>
    </select>
    <select id="modelSizeDropdown">
      <option value="small" selected>Small</option>
      <option value="large-v3">Large-v3</option>
    </select>
    <select id="captionLinesDropdown">
      <option value="3" selected>3</option>
    </select>
  `;
}

function loadPopup() {
  jest.resetModules();
  require('../mentions.js');
  require('../popup.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
}

function clickStart(tabId = 1) {
  chrome.tabs.query.mockImplementation((_, cb) => cb([{ id: tabId }]));
  document.getElementById('startCapture').click();
}

// ---------------------------------------------------------------------------
// 1. WebSocket URL construction — pure logic extracted from options.js
// ---------------------------------------------------------------------------

describe('WebSocket URL construction', () => {
  function buildWsUrl(host, port) {
    return port
      ? `ws://${host}:${port}/`
      : `wss://${host}/ws`;
  }

  test('local server: ws:// with port and trailing slash', () => {
    expect(buildWsUrl('localhost', '9090')).toBe('ws://localhost:9090/');
  });

  test('Modal service (empty port): wss:// with /ws path', () => {
    expect(buildWsUrl('boxerab--aavaaz-live-livetranscriber-web.modal.run', '')).toBe(
      'wss://boxerab--aavaaz-live-livetranscriber-web.modal.run/ws'
    );
  });

  test('custom host+port stays on ws://', () => {
    expect(buildWsUrl('my-server.example.com', '7090')).toBe(
      'ws://my-server.example.com:7090/'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. popup.js — host/port selection based on checkbox
// ---------------------------------------------------------------------------

describe('popup.js host/port selection', () => {
  beforeEach(() => {
    resetStorage();
    buildPopupDOM();
    jest.clearAllMocks();
  });

  test('default server → localhost:9090', async () => {
    loadPopup();
    clickStart();
    await flushPromises();

    const call = chrome.runtime.sendMessage.mock.calls.find(
      c => c[0] && c[0].action === 'startCapture'
    );
    expect(call).toBeDefined();
    expect(call[0].host).toBe('localhost');
    expect(call[0].port).toBe('9090');
  });

  test('configured server and empty port are forwarded', async () => {
    storageData.serverHost = 'whisper.example.test';
    storageData.serverPort = '';
    loadPopup();
    clickStart();
    await flushPromises();

    const call = chrome.runtime.sendMessage.mock.calls.find(
      c => c[0] && c[0].action === 'startCapture'
    );
    expect(call).toBeDefined();
    expect(call[0].host).toBe('whisper.example.test');
    expect(call[0].port).toBe('');
  });

  test('startCapture message carries language, task, and modelSize', async () => {
    document.getElementById('languageDropdown').value = 'en';
    document.getElementById('taskDropdown').value = 'transcribe';
    document.getElementById('modelSizeDropdown').value = 'large-v3';
    loadPopup();
    clickStart();
    await flushPromises();

    const call = chrome.runtime.sendMessage.mock.calls.find(
      c => c[0] && c[0].action === 'startCapture'
    );
    expect(call).toBeDefined();
    expect(call[0].task).toBe('transcribe');
    expect(call[0].modelSize).toBe('large-v3');
  });
});

// ---------------------------------------------------------------------------
// 3. popup.js — button state management
// ---------------------------------------------------------------------------

describe('popup.js button state', () => {
  beforeEach(() => {
    resetStorage();
    buildPopupDOM();
    jest.clearAllMocks();
  });

  test('start button enabled and stop button disabled on load (not capturing)', () => {
    storageData.capturingState = { isCapturing: false };
    loadPopup();
    expect(document.getElementById('startCapture').disabled).toBeFalsy();
    expect(document.getElementById('stopCapture').disabled).toBe(true);
  });

  test('stop button enabled on load when already capturing', () => {
    storageData.capturingState = { isCapturing: true };
    loadPopup();
    expect(document.getElementById('stopCapture').disabled).toBe(false);
  });

  test('clicking stop sends stopCapture action to runtime', () => {
    storageData.capturingState = { isCapturing: true };
    loadPopup();
    // toggleCaptureButtons(true) disables startCapture and enables stopCapture
    document.getElementById('stopCapture').click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stopCapture' }),
      expect.any(Function)
    );
  });
});

// ---------------------------------------------------------------------------
// 4. popup.js — storage state restoration on open
// ---------------------------------------------------------------------------

describe('popup.js storage restoration', () => {
  beforeEach(() => {
    resetStorage();
    buildPopupDOM();
    jest.clearAllMocks();
  });

  test('restores server host from storage', () => {
    storageData.serverHost = '192.168.1.10';
    loadPopup();
    expect(document.getElementById('serverHost').value).toBe('192.168.1.10');
  });

  test('restores language selection from storage', () => {
    storageData.selectedLanguage = 'en';
    loadPopup();
    expect(document.getElementById('languageDropdown').value).toBe('en');
  });

  test('restores model size from storage', () => {
    storageData.selectedModelSize = 'large-v3';
    loadPopup();
    expect(document.getElementById('modelSizeDropdown').value).toBe('large-v3');
  });
});

describe('mention settings in popup', () => {
  beforeEach(() => {
    resetStorage();
    buildPopupDOM();
    jest.clearAllMocks();
  });

  test('uses Russian defaults and saves edits immediately', () => {
    loadPopup();
    const words = document.getElementById('watchWords');
    expect(words.value).toBe('Вячеслав\nСлав\nСлава');
    words.value = 'Серёжа, billing\nСерёжа';
    words.dispatchEvent(new Event('input'));
    expect(storageData.watchWords).toEqual(['Серёжа', 'billing']);
    document.getElementById('mentionSound').checked = false;
    document.getElementById('mentionSound').dispatchEvent(new Event('change'));
    expect(storageData.mentionSound).toBe(false);
  });

  test('restores last mention and updates it while popup is open', () => {
    storageData.lastMention = { text: 'Слава, посмотри billing', timestamp: 1000 };
    loadPopup();
    expect(document.getElementById('lastMentionText').textContent).toBe(storageData.lastMention.text);
    expect(document.getElementById('lastMentionTime').dateTime).toBe(new Date(1000).toISOString());
    const listener = chrome.storage.onChanged.addListener.mock.calls.at(-1)[0];
    listener({ lastMention: { newValue: { text: 'Вячеславу', timestamp: 2000 } } }, 'local');
    expect(document.getElementById('lastMentionText').textContent).toBe('Вячеславу');
  });
});
