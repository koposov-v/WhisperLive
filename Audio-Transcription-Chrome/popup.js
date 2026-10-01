// Wait for the DOM content to be fully loaded
document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startCapture");
  const stopButton = document.getElementById("stopCapture");

  const serverHost = document.getElementById("serverHost");
  const serverPort = document.getElementById("serverPort");
  const mentionEnabled = document.getElementById("mentionEnabled");
  const mentionSound = document.getElementById("mentionSound");
  const watchWords = document.getElementById("watchWords");
  const captureStatus = document.getElementById("captureStatus");

  function showLastMention(mention) {
    document.getElementById("lastMentionText").textContent = mention ? mention.text : '—';
    const time = document.getElementById("lastMentionTime");
    time.textContent = mention ? new Date(mention.timestamp).toLocaleString() : '';
    time.dateTime = mention ? new Date(mention.timestamp).toISOString() : '';
  }

  chrome.storage.local.get({ ...Mentions.DEFAULT_SETTINGS, serverHost: 'localhost', serverPort: '9090', lastMention: null }, settings => {
    mentionEnabled.checked = settings.mentionEnabled;
    mentionSound.checked = settings.mentionSound;
    watchWords.value = settings.watchWords.join('\n');
    serverHost.value = settings.serverHost;
    serverPort.value = settings.serverPort;
    showLastMention(settings.lastMention);
  });

  function saveMentionSettings() {
    chrome.storage.local.set({
      mentionEnabled: mentionEnabled.checked,
      mentionSound: mentionSound.checked,
      watchWords: Mentions.parseWatchWords(watchWords.value),
    });
  }

  mentionEnabled.addEventListener('change', saveMentionSettings);
  mentionSound.addEventListener('change', saveMentionSettings);
  watchWords.addEventListener('input', saveMentionSettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lastMention) showLastMention(changes.lastMention.newValue);
  });
  const useVadCheckbox = document.getElementById("useVadCheckbox");
  const saveCaptionsCheckbox = document.getElementById("saveCaptionsCheckbox");
  const languageDropdown = document.getElementById('languageDropdown');
  const taskDropdown = document.getElementById('taskDropdown');
  const modelSizeDropdown = document.getElementById('modelSizeDropdown');
  const captionLinesDropdown = document.getElementById('captionLinesDropdown');
  let selectedLanguage = null;
  let selectedTask = taskDropdown.value;
  let selectedModelSize = modelSizeDropdown.value;
  let selectedCaptionLines = captionLinesDropdown.value;

  // Add click event listeners to the buttons
  startButton.addEventListener("click", startCapture);
  stopButton.addEventListener("click", stopCapture);

  // Retrieve capturing state from storage on popup open
  chrome.storage.local.get("capturingState", ({ capturingState }) => {
    if (capturingState && capturingState.isCapturing) {
      toggleCaptureButtons(true);
    } else {
      toggleCaptureButtons(false);
    }
  });

  // Retrieve checkbox state from storage on popup open
  chrome.storage.local.get("useVadState", ({ useVadState }) => {
    if (useVadState !== undefined) {
      useVadCheckbox.checked = useVadState;
    }
  });

  chrome.storage.local.get("saveCaptionsState", ({ saveCaptionsState }) => {
    if (saveCaptionsState !== undefined) {
      saveCaptionsCheckbox.checked = saveCaptionsState;
    }
  });

  chrome.storage.local.get("selectedLanguage", ({ selectedLanguage: storedLanguage }) => {
    if (storedLanguage !== undefined) {
      languageDropdown.value = storedLanguage;
      selectedLanguage = storedLanguage;
    }
  });

  chrome.storage.local.get("selectedTask", ({ selectedTask: storedTask }) => {
    if (storedTask !== undefined) {
      taskDropdown.value = storedTask;
      selectedTask = storedTask;
    }
  });

  chrome.storage.local.get("selectedModelSize", ({ selectedModelSize: storedModelSize }) => {
    if (storedModelSize !== undefined) {
      modelSizeDropdown.value = storedModelSize;
      selectedModelSize = storedModelSize;
    }
  });

  chrome.storage.local.get("selectedCaptionLines", ({ selectedCaptionLines: storedCaptionLines }) => {
    if (storedCaptionLines !== undefined) {
      captionLinesDropdown.value = storedCaptionLines;
      selectedCaptionLines = storedCaptionLines;
    }
  });

  // Function to handle the start capture button click event
  async function startCapture() {
    // Ignore click if the button is disabled
    if (startButton.disabled) {
      return;
    }
    startButton.disabled = true;
    captureStatus.textContent = '';

    // Get the current active tab
    const currentTab = await getCurrentTab();

    // Send a message to the background script to start capturing
    const host = serverHost.value.trim() || 'localhost';
    const port = serverPort.value.trim();
    saveMentionSettings();
    chrome.storage.local.set({ serverHost: host, serverPort: port });

    chrome.runtime.sendMessage(
      { 
        action: "startCapture", 
        tabId: currentTab.id,
        host: host,
        port: port,
        language: selectedLanguage,
        task: selectedTask,
        modelSize: selectedModelSize,
        useVad: useVadCheckbox.checked,
        saveCaptions: saveCaptionsCheckbox.checked,
        captionLines: Number(selectedCaptionLines),
      }, (response) => {
        if (chrome.runtime.lastError || !response || !response.started) {
          captureStatus.textContent = chrome.runtime.lastError?.message || response?.error || 'Не удалось начать захват аудио.';
          toggleCaptureButtons(false);
          return;
        }
        // Update capturing state in storage and toggle the buttons
        chrome.storage.local.set({ capturingState: { isCapturing: true } }, () => {
          toggleCaptureButtons(true);
        });
      }
    );
  }

  // Function to handle the stop capture button click event
  function stopCapture() {
    // Ignore click if the button is disabled
    if (stopButton.disabled) {
      return;
    }
    stopButton.disabled = true;

    // Send a message to the background script to stop capturing
    chrome.runtime.sendMessage(
      { 
        action: "stopCapture",
        saveCaptions: saveCaptionsCheckbox.checked,
      }, () => {
      // Update capturing state in storage and toggle the buttons
      chrome.storage.local.set({ capturingState: { isCapturing: false } }, () => {
        toggleCaptureButtons(false);
      });
    });
  }

  // Function to get the current active tab
  async function getCurrentTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0]);
      });
    });
  }

  // Function to toggle the capture buttons based on the capturing state
  function toggleCaptureButtons(isCapturing) {
    startButton.disabled = isCapturing;
    stopButton.disabled = !isCapturing;
    serverHost.disabled = isCapturing;
    serverPort.disabled = isCapturing;
    useVadCheckbox.disabled = isCapturing;
    saveCaptionsCheckbox.disabled = isCapturing;
    modelSizeDropdown.disabled = isCapturing;
    languageDropdown.disabled = isCapturing;
    taskDropdown.disabled = isCapturing;
    captionLinesDropdown.disabled = isCapturing;
    startButton.classList.toggle("disabled", isCapturing);
    stopButton.classList.toggle("disabled", !isCapturing);
  }

  // Save the checkbox state when it's toggled
  useVadCheckbox.addEventListener("change", () => {
    const useVadState = useVadCheckbox.checked;
    chrome.storage.local.set({ useVadState });
  });

  saveCaptionsCheckbox.addEventListener("change", () => {
    const saveCaptionsState = saveCaptionsCheckbox.checked;
    chrome.storage.local.set({ saveCaptionsState });
  });

  languageDropdown.addEventListener('change', function() {
    if (languageDropdown.value === "") {
      selectedLanguage = null;
    } else {
      selectedLanguage = languageDropdown.value;
    }
    chrome.storage.local.set({ selectedLanguage });
  });

  taskDropdown.addEventListener('change', function() {
    selectedTask = taskDropdown.value;
    chrome.storage.local.set({ selectedTask });
  });

  modelSizeDropdown.addEventListener('change', function() {
    selectedModelSize = modelSizeDropdown.value;
    chrome.storage.local.set({ selectedModelSize });
  });

  captionLinesDropdown.addEventListener('change', function() {
    selectedCaptionLines = captionLinesDropdown.value;
    chrome.storage.local.set({ selectedCaptionLines });
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateSelectedLanguage") {
      const detectedLanguage = request.detectedLanguage;
  
      if (detectedLanguage) {
        languageDropdown.value = detectedLanguage;
        chrome.storage.local.set({ selectedLanguage: detectedLanguage });
      }
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggleCaptureButtons") {
      toggleCaptureButtons(false);
      chrome.storage.local.set({ capturingState: { isCapturing: false } })
    }
  });
  
});
