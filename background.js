"use strict";

const POPUP_MESSAGE_TYPE = "david:popup-command";
const CONTENT_MESSAGE_TYPE = "david:command";
const ALLOWED_COMMANDS = new Set(["quick-copy", "select-messages", "save-markdown", "export-babel"]);
let screenshotQueue = Promise.resolve();
let lastScreenshotAt = 0;
const shortcutInFlight = new Set();

chrome.commands.onCommand.addListener((command, tab) => {
  if (ALLOWED_COMMANDS.has(command)) void runShortcutCommand(command, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "david:capture-visible") {
    void captureSenderTab(sender)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Chrome could not capture the active tab." }));
    return true;
  }
  if (message?.type !== POPUP_MESSAGE_TYPE) {
    return false;
  }

  void runActiveTabCommand(message.command)
    .then(sendResponse)
    .catch((error) => {
      console.error("David could not run on this page.", error);
      sendResponse({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "David could not run on this page."
      });
    });
  return true;
});

async function runActiveTabCommand(command, options = {}) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error("David received an unknown command.");
  }

  const tab = options.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !isInjectableUrl(tab.url)) {
    throw new Error("Open a regular web page before using David.");
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["archive.js", "content.js"]
  });

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: CONTENT_MESSAGE_TYPE,
    command,
    ...(options.trigger ? { trigger: options.trigger } : {})
  });
  return response || { ok: true };
}

async function runShortcutCommand(command, suppliedTab) {
  let tab = suppliedTab;
  let key;
  let ownsLock = false;
  try {
    if (!ALLOWED_COMMANDS.has(command)) throw new Error("David received an unknown command.");
    tab ||= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    key = tab?.id ?? "active";
    if (shortcutInFlight.has(key)) return { ok: true, action: "ignored-busy" };
    shortcutInFlight.add(key);
    ownsLock = true;
    const response = await runActiveTabCommand(command, { tab, trigger: "shortcut" });
    if (!response?.ok) throw new Error(response?.error || "David could not complete this shortcut.");
    await setShortcutStatus(tab);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "David could not complete this shortcut.";
    console.error("David shortcut:", error);
    await setShortcutStatus(tab, message);
    return { ok: false, error: message };
  } finally {
    if (ownsLock) shortcutInFlight.delete(key);
  }
}

async function setShortcutStatus(tab, error) {
  const scope = tab?.id === undefined ? {} : { tabId: tab.id };
  try {
    await chrome.action.setBadgeText({ ...scope, text: error ? "!" : "" });
    if (error) await chrome.action.setBadgeBackgroundColor({ ...scope, color: "#b91c1c" });
    await chrome.action.setTitle({ ...scope, title: error ? `David: ${error}` : chrome.runtime.getManifest().action.default_title });
  } catch { /* The source tab may have closed while the command finished. */ }
}

function captureSenderTab(sender) {
  screenshotQueue = screenshotQueue.catch(() => undefined).then(async () => {
    if (sender?.id !== chrome.runtime.id || !sender.tab?.id || !isInjectableUrl(sender.tab.url)) {
      throw new Error("Only a David capture in the active web tab can request a screenshot.");
    }
    const wait = Math.max(0, 550 - (Date.now() - lastScreenshotAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const [active] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
    if (active?.id !== sender.tab.id) throw new Error("The source tab is no longer active. Keep it active while exporting.");
    lastScreenshotAt = Date.now();
    return chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  });
  return screenshotQueue;
}

function isInjectableUrl(rawUrl) {
  if (!rawUrl) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
