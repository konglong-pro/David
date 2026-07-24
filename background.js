"use strict";

const POPUP_MESSAGE_TYPE = "david:popup-command";
const CONTENT_MESSAGE_TYPE = "david:command";
const ALLOWED_COMMANDS = new Set(["quick-copy", "select-messages"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

async function runActiveTabCommand(command) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error("David received an unknown command.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isInjectableUrl(tab.url)) {
    throw new Error("Open a regular web page before using David.");
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: CONTENT_MESSAGE_TYPE,
    command
  });
  return response || { ok: true };
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
