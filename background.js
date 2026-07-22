"use strict";

const DEFAULT_TITLE = "Copy selection or AI conversation as Markdown";

chrome.action.onClicked.addListener((tab) => {
  void copyConversation(tab);
});

async function copyConversation(tab) {
  if (!tab.id || !isInjectableUrl(tab.url)) {
    if (tab.id) {
      await showBadge(tab.id, "!", "#b91c1c", "David needs a regular web page");
    }
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    console.error("David could not run on this page.", error);
    await showBadge(tab.id, "!", "#b91c1c", "David could not copy this page");
  }
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

async function showBadge(tabId, text, color, title) {
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setTitle({ tabId, title })
  ]);

  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" });
    void chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
  }, 2500);
}
