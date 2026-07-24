"use strict";

const POPUP_MESSAGE_TYPE = "david:popup-command";
const quickCopyButton = document.getElementById("quick-copy");
const selectMessagesButton = document.getElementById("select-messages");
const status = document.getElementById("status");
const buttons = [quickCopyButton, selectMessagesButton];
let busy = false;

quickCopyButton.addEventListener("click", () => void runCommand("quick-copy"));
selectMessagesButton.addEventListener("click", () =>
  void runCommand("select-messages")
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.close();
    return;
  }
  if (busy || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const key = event.key.toLowerCase();
  if (key === "c") {
    event.preventDefault();
    void runCommand("quick-copy");
  } else if (key === "s") {
    event.preventDefault();
    void runCommand("select-messages");
  }
});

quickCopyButton.focus();

async function runCommand(command) {
  if (busy) {
    return;
  }

  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: POPUP_MESSAGE_TYPE,
      command
    });
    if (!response?.ok) {
      throw new Error(response?.error || "David could not complete this action.");
    }
    window.close();
  } catch (error) {
    status.dataset.state = "error";
    status.textContent =
      error instanceof Error ? error.message : "David could not complete this action.";
    setBusy(false);
  }
}

function setBusy(isBusy) {
  busy = isBusy;
  for (const button of buttons) {
    button.disabled = isBusy;
  }
  if (isBusy) {
    status.dataset.state = "working";
    status.textContent = "Working…";
  }
}
