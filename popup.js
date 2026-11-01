"use strict";

const POPUP_MESSAGE_TYPE = "david:popup-command";
const quickCopyButton = document.getElementById("quick-copy");
const selectMessagesButton = document.getElementById("select-messages");
const saveMarkdownButton = document.getElementById("save-markdown");
const exportBabelButton = document.getElementById("export-babel");
const configureShortcutsButton = document.getElementById("configure-shortcuts");
const status = document.getElementById("status");
const buttons = [quickCopyButton, selectMessagesButton, saveMarkdownButton, exportBabelButton];
let busy = false;

quickCopyButton.addEventListener("click", () => void runCommand("quick-copy"));
selectMessagesButton.addEventListener("click", () =>
  void runCommand("select-messages")
);
saveMarkdownButton.addEventListener("click", () => void runCommand("save-markdown"));
exportBabelButton.addEventListener("click", () => void runCommand("export-babel"));
configureShortcutsButton.addEventListener("click", () => void openShortcutSettings());

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
    event.composedPath().some((node) => node instanceof Element &&
      (node.matches('input, textarea, select, [role="textbox"], [role="combobox"]') || node.isContentEditable))) return;
  if (event.key === "Escape") {
    event.preventDefault();
    window.close();
    return;
  }
  if (busy || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const key = event.key.toLowerCase();
  if (key === "b") {
    event.preventDefault();
    void runCommand("export-babel");
  } else if (key === "c") {
    event.preventDefault();
    void runCommand("quick-copy");
  } else if (key === "s") {
    event.preventDefault();
    void runCommand("select-messages");
  } else if (key === "d") {
    event.preventDefault();
    void runCommand("save-markdown");
  }
});

quickCopyButton.focus();
void refreshBrowserShortcuts();

async function refreshBrowserShortcuts() {
  const help = document.getElementById("shortcut-status");
  const labels = [...document.querySelectorAll("[data-command-shortcut]")];
  try {
    const commands = await chrome.commands.getAll();
    const bindings = new Map(commands.map((command) => [command.name, command.shortcut || ""]));
    let unassigned = false;
    for (const label of labels) {
      const shortcut = bindings.get(label.dataset.commandShortcut) || "";
      label.textContent = shortcut || "Unassigned";
      unassigned ||= !shortcut;
    }
    help.textContent = unassigned
      ? "Some browser shortcuts are unassigned. Configure them below."
      : "Browser shortcuts work while Chrome has focus.";
  } catch {
    for (const label of labels) label.textContent = "Unavailable";
    help.textContent = "Open shortcut settings to check your current bindings.";
  }
}

async function openShortcutSettings() {
  try {
    await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    window.close();
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = error instanceof Error ? error.message : "Open chrome://extensions/shortcuts in Chrome.";
  }
}

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
  configureShortcutsButton.disabled = isBusy;
  if (isBusy) {
    status.dataset.state = "working";
    status.textContent = "Working…";
  }
}
