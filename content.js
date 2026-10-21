(() => {
  "use strict";

  if (globalThis.__davidMarkdownControllerV1) {
    return;
  }
  globalThis.__davidMarkdownControllerV1 = true;

  const TOAST_ID = "david-copy-markdown-toast";
  const SELECTOR_HOST_ID = "david-message-selector";
  const SELECTOR_STYLE_ID = "david-message-selector-style";
  const COMMAND_QUICK_COPY = "quick-copy";
  const COMMAND_SELECT_MESSAGES = "select-messages";
  const COMMAND_SAVE_MARKDOWN = "save-markdown";
  const COMMAND_EXPORT_BABEL = "export-babel";
  const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
  const CHATGPT_MESSAGE_SELECTOR =
    '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const CHATGPT_USER_BODY_SELECTOR = '[data-user-message-bubble="true"]';
  const CHATGPT_ASSISTANT_BODY_SELECTOR = '[data-markdown-text-style="assistant-message"]';
  const IGNORED_CLASS_NAMES = new Set([
    "sr-only",
    "screen-reader-user-query-label",
    "screen-reader-model-response-label",
    "model-response-label-announcer"
  ]);
  const SKIPPED_TAGS = new Set([
    "BUTTON",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION"
  ]);
  const BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "PRE",
    "UL",
    "OL",
    "BLOCKQUOTE",
    "TABLE",
    "HR"
  ]);
  const MATH_SELECTOR = [
    "[data-math]",
    "[data-tex]",
    "[data-latex]",
    "[data-math-source]",
    "[data-tex-source]",
    "[data-latex-source]",
    "[data-math-style]",
    ".math-inline",
    ".math-block",
    ".katex",
    ".katex-display",
    "[class*='math-inline']",
    "[class*='math-display']",
    "[class*='math-block']",
    "[class*='mathml']",
    "[class*='katex']",
    "[class*='mathjax']",
    "[class*='MathJax']",
    "[class*='latex']",
    "math",
    "mjx-container"
  ].join(",");
  const MATH_SOURCE_SELECTOR = [
    "[data-math]",
    "[data-tex]",
    "[data-latex]",
    "[data-math-source]",
    "[data-tex-source]",
    "[data-latex-source]",
    "[data-original-tex]",
    "[data-original-latex]",
    "[data-raw-tex]",
    "[data-raw-latex]",
    "math[alttext]",
    "mjx-container[alttext]"
  ].join(",");
  const MATH_SOURCE_ATTRIBUTES = [
    "data-math",
    "data-tex",
    "data-latex",
    "data-math-source",
    "data-tex-source",
    "data-latex-source",
    "data-original-tex",
    "data-original-latex",
    "data-raw-tex",
    "data-raw-latex"
  ];
  let messageSelectionController = null;
  let shortcutInProgress = false;
  let archiveExportInProgress = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "david:command") {
      return false;
    }

    void (message.trigger === "shortcut" ? handleShortcutCommand(message.command) : handleCommand(message.command))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage = getErrorMessage(error);
        console.error("David:", error);
        showToast(errorMessage, true);
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  });

  async function handleCommand(command) {
    switch (command) {
      case COMMAND_QUICK_COPY:
        return quickCopy();
      case COMMAND_SELECT_MESSAGES:
        return enterMessageSelectionMode();
      case COMMAND_SAVE_MARKDOWN:
        return saveCurrentMarkdown();
      case COMMAND_EXPORT_BABEL:
        return exportForBabel();
      default:
        throw new Error("David received an unknown command.");
    }
  }

  async function handleShortcutCommand(command) {
    if (shortcutInProgress || archiveExportInProgress) return { action: "ignored-busy" };
    shortcutInProgress = true;
    try {
      const selector = messageSelectionController;
      if (selector) {
        if (command === COMMAND_SELECT_MESSAGES) return { action: "selection-mode-active" };
        if ([COMMAND_QUICK_COPY, COMMAND_SAVE_MARKDOWN, COMMAND_EXPORT_BABEL].includes(command)) {
          const selected = selector.selectedRecords();
          if (!selected.length) throw new Error("Select at least one message before using an export shortcut.");
          if (command === COMMAND_EXPORT_BABEL) return exportForBabel(selected);
          return await selector.copySelected(command === COMMAND_SAVE_MARKDOWN);
        }
      }
      return await handleCommand(command);
    } finally { shortcutInProgress = false; }
  }

  async function quickCopy() {
    messageSelectionController?.cancel();

    const selectionMarkdown = extractSelectionMarkdown();
    if (selectionMarkdown) {
      await writeClipboard(selectionMarkdown);
      showToast("Copied selection as Markdown.", false);
      return { action: "copied-selection" };
    }

    const adapter = getConversationAdapter();
    if (!adapter) {
      throw new Error("Select some content before using Quick Copy.");
    }

    const conversation = extractConversation(adapter);
    await writeClipboard(conversation.markdown);
    showToast(`Copied ${conversation.count} messages as Markdown.`, false);
    return { action: "copied-conversation", count: conversation.count };
  }

  function saveCurrentMarkdown() {
    messageSelectionController?.cancel();
    const selection = extractSelectionMarkdown();
    if (selection) {
      saveMarkdown(selection);
      showToast("Markdown download started. Import the .md file in Babel.", false);
      return { action: "saved-selection" };
    }
    const adapter = getConversationAdapter();
    if (!adapter) {
      throw new Error("Select some content before saving Markdown.");
    }
    const conversation = extractConversation(adapter);
    saveMarkdown(conversation.markdown);
    showToast(`Markdown download started (${conversation.count} messages). Import the .md file in Babel.`, false);
    return { action: "saved-conversation", count: conversation.count };
  }

  function validateMarkdownSize(text) {
    if (new TextEncoder().encode(text).byteLength > MAX_MARKDOWN_BYTES) {
      throw new Error("Markdown exceeds Babel's 10 MiB limit. Select a smaller message range.");
    }
    return text;
  }

  function exportForBabel(selectedRecords = null) {
    if (archiveExportInProgress) return { action: "ignored-busy" };
    const capture = globalThis.__davidArchiveV1;
    if (!capture) throw new Error("Reload David and refresh this page before exporting a Babel archive.");
    const options = {
      toMarkdown: (element, role) => elementToMarkdown(element, {
        headingOffset: role ? 2 : 0, preserveTextNewlines: role === "user", archiveAssets: true
      })
    };
    if (selectedRecords) {
      options.records = selectedRecords.map((record) => ({ root: record.root, role: record.role }));
    } else {
      const control = extractControlSelection();
      const selection = window.getSelection();
      if (control) {
        options.text = control;
      } else if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        options.ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
        const roots = new Set(options.ranges.map((range) => {
          const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
          return element.closest("svg,canvas,math,mjx-container,.katex,.katex-display,.math-inline,.math-block,[data-math],[data-tex],[data-latex]") || element;
        }));
        options.records = [...roots].map((root) => ({ root }));
      } else {
        const adapter = getConversationAdapter();
        if (!adapter) throw new Error("Select some displayed content before exporting a Babel archive.");
        options.records = getConversationRecords(adapter).map((record) => ({ root: record.root, role: record.role }));
        if (!options.records.length) throw new Error(`No ${adapter.name} conversation was found on this page.`);
      }
    }
    messageSelectionController?.cancel();
    archiveExportInProgress = true;
    void capture.captureAndSave(options)
      .then((result) => showToast(`Babel archive download started (${result.assets} images${result.warnings ? `, ${result.warnings} capture warnings` : ""}). Import the .babel.json file in Babel.`, false))
      .catch((error) => { console.error("David archive:", error); showToast(getErrorMessage(error), true); })
      .finally(() => { archiveExportInProgress = false; });
    return { action: "archive-started" };
  }

  function markdownFilename(title = document.title) {
    const base = (title || "conversation")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/^[ .]+|[ .]+$/g, "")
      .slice(0, 100)
      .replace(/[ .]+$/g, "") || "conversation";
    return `${base.replace(/\.md$/i, "")}.md`;
  }

  function saveMarkdown(text) {
    validateMarkdownSize(text);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = markdownFilename();
    anchor.hidden = true;
    (document.body || document.documentElement).appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : "David could not complete this action.";
  }

  function extractSelectionMarkdown() {
    const controlSelection = extractControlSelection();
    if (controlSelection) {
      return controlSelection;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }

    const selectedText = selection.toString();

    const container = document.createElement("div");
    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (index > 0) {
        container.appendChild(document.createElement("br"));
      }
      const range = expandRangeToMathBoundaries(selection.getRangeAt(index));
      container.appendChild(range.cloneContents());
    }

    return (
      elementToMarkdown(container, { headingOffset: 0 }) || selectedText.trim() || null
    );
  }

  function expandRangeToMathBoundaries(range) {
    const expanded = range.cloneRange();
    const startMath = findMathBoundaryRoot(range.startContainer);
    const endMath = findMathBoundaryRoot(range.endContainer);

    if (startMath) {
      expanded.setStartBefore(startMath);
    }
    if (endMath) {
      expanded.setEndAfter(endMath);
    }

    return expanded;
  }

  function findMathBoundaryRoot(node) {
    const element =
      node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    let mathRoot = element?.closest(MATH_SELECTOR) || null;

    while (mathRoot?.parentElement?.matches(MATH_SELECTOR)) {
      mathRoot = mathRoot.parentElement;
    }

    return mathRoot;
  }

  function extractControlSelection() {
    const activeElement = document.activeElement;
    const isTextarea = activeElement instanceof HTMLTextAreaElement;
    const isSupportedInput =
      activeElement instanceof HTMLInputElement &&
      ["text", "search", "url", "tel", "email"].includes(activeElement.type);

    if (!isTextarea && !isSupportedInput) {
      return null;
    }

    const start = activeElement.selectionStart;
    const end = activeElement.selectionEnd;
    if (start === null || end === null || start === end) {
      return null;
    }

    return normalizeNewlines(activeElement.value.slice(start, end)).trim() || null;
  }

  function getConversationAdapter() {
    switch (window.location.hostname) {
      case "chatgpt.com":
      case "chat.openai.com":
        return {
          name: "ChatGPT",
          getMessages: getChatGPTMessages
        };
      case "gemini.google.com":
        return {
          name: "Gemini",
          getMessages: getGeminiMessages
        };
      case "claude.ai":
        return {
          name: "Claude",
          getMessages: getClaudeMessages
        };
      default:
        return null;
    }
  }

  function getConversationRecords(adapter) {
    const records = [];
    const seen = new Set();

    for (const record of adapter.getMessages()) {
      if (!isRendered(record.root)) {
        continue;
      }

      if (record.role !== "user" && record.role !== "assistant") {
        continue;
      }

      const key = record.key || record.root;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      records.push(record);
    }

    return records;
  }

  function extractConversation(adapter, selectedRecords = null) {
    const messages = [];
    const records = selectedRecords || getConversationRecords(adapter);

    for (const record of records) {
      const markdown =
        record.role === "user"
          ? extractUserText(record.content)
          : elementToMarkdown(record.content, { headingOffset: 2 });

      if (markdown.trim()) {
        messages.push({ role: record.role, markdown: markdown.trim() });
      }
    }

    if (messages.length === 0) {
      throw new Error(`No ${adapter.name} conversation was found on this page.`);
    }

    const markdown = messages
      .map(({ role, markdown: body }) => {
        const label = role === "user" ? "User" : "Assistant";
        return `## ${label}\n\n${body}`;
      })
      .join("\n\n")
      .trim();

    return { markdown, count: messages.length };
  }

  function enterMessageSelectionMode() {
    messageSelectionController?.cancel();

    const adapter = getConversationAdapter();
    if (!adapter) {
      throw new Error(
        "Select Messages is available on ChatGPT, Gemini, and Claude conversations."
      );
    }

    const records = getConversationRecords(adapter);
    if (records.length === 0) {
      throw new Error(`No ${adapter.name} conversation was found on this page.`);
    }

    window.getSelection()?.removeAllRanges();
    const controller = createMessageSelectionController(adapter, records);
    messageSelectionController = controller;
    controller.start();
    showToast("Selection mode is active. Click a message to begin.", false);
    return { action: "selection-mode", count: records.length };
  }

  function createMessageSelectionController(adapter, initialRecords) {
    const SELECTABLE_ATTRIBUTE = "data-david-message-selectable";
    const SELECTED_ATTRIBUTE = "data-david-message-selected";
    const ANCHOR_ATTRIBUTE = "data-david-message-anchor";
    let records = initialRecords;
    let recordKeys = makeRecordKeys(records);
    let anchorKey = null;
    let endKey = null;
    let host = null;
    let shadow = null;
    let style = null;
    let observer = null;
    let refreshTimer = null;
    let countLabel = null;
    let copyButton = null;
    let saveButton = null;
    let archiveButton = null;
    let resetButton = null;

    function start() {
      document.getElementById(SELECTOR_HOST_ID)?.remove();
      document.getElementById(SELECTOR_STYLE_ID)?.remove();

      style = document.createElement("style");
      style.id = SELECTOR_STYLE_ID;
      style.textContent = `
        [${SELECTABLE_ATTRIBUTE}="true"] {
          cursor: pointer !important;
          outline-offset: 4px !important;
          transition: outline-color 100ms ease, box-shadow 100ms ease !important;
        }
        [${SELECTABLE_ATTRIBUTE}="true"]:hover:not([${SELECTED_ATTRIBUTE}="true"]) {
          outline: 2px dashed #64748b !important;
        }
        [${SELECTED_ATTRIBUTE}="true"] {
          outline: 3px solid #2563eb !important;
          box-shadow: 0 0 0 6px rgba(37, 99, 235, 0.14) !important;
        }
        [${ANCHOR_ATTRIBUTE}="true"] {
          outline-color: #1d4ed8 !important;
        }
      `;
      document.documentElement.appendChild(style);

      host = document.createElement("div");
      host.id = SELECTOR_HOST_ID;
      Object.assign(host.style, {
        position: "fixed",
        left: "50%",
        bottom: "24px",
        zIndex: "2147483646",
        transform: "translateX(-50%)"
      });
      shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; }
          .panel {
            width: min(620px, calc(100vw - 32px));
            padding: 14px;
            border: 1px solid #cbd5e1;
            border-radius: 14px;
            background: #ffffff;
            color: #0f172a;
            box-shadow: 0 18px 50px rgba(15, 23, 42, 0.24);
            font: 500 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .topline {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 10px;
          }
          .title { font-weight: 750; }
          .count { color: #475569; font-size: 13px; }
          .hint { margin: 0 0 12px; color: #475569; font-size: 13px; }
          .actions { display: flex; flex-wrap: wrap; gap: 8px; }
          button {
            min-height: 36px;
            padding: 7px 12px;
            border: 1px solid #cbd5e1;
            border-radius: 9px;
            background: #ffffff;
            color: #0f172a;
            cursor: pointer;
            font: 650 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          button:hover:not(:disabled) { background: #f8fafc; border-color: #94a3b8; }
          button:focus-visible { outline: 3px solid rgba(37, 99, 235, 0.35); outline-offset: 2px; }
          button:disabled { cursor: not-allowed; opacity: 0.45; }
          .primary { border-color: #1d4ed8; background: #2563eb; color: #ffffff; }
          .primary:hover:not(:disabled) { border-color: #1e40af; background: #1d4ed8; }
          .cancel { margin-left: auto; }
          @media (max-width: 520px) { .cancel { margin-left: 0; } }
        </style>
        <section class="panel" role="dialog" aria-label="Select conversation messages">
          <div class="topline">
            <span class="title">Select Messages</span>
            <span class="count" id="count">No messages selected</span>
          </div>
          <p class="hint">Click a message to set the start. Click another message to set the end.</p>
          <div class="actions">
            <button class="primary" id="copy" type="button" disabled>Copy</button>
            <button id="save" type="button" disabled>Save Markdown</button>
            <button id="archive" type="button" disabled>Export for Babel</button>
            <button id="all" type="button">Select all</button>
            <button id="reset" type="button" disabled>Start over</button>
            <button class="cancel" id="cancel" type="button">Cancel</button>
          </div>
        </section>
      `;
      (document.body || document.documentElement).appendChild(host);

      countLabel = shadow.getElementById("count");
      copyButton = shadow.getElementById("copy");
      saveButton = shadow.getElementById("save");
      archiveButton = shadow.getElementById("archive");
      resetButton = shadow.getElementById("reset");
      copyButton.addEventListener("click", () => void copySelected());
      saveButton.addEventListener("click", () => void copySelected(true));
      archiveButton.addEventListener("click", () => {
        refreshRecords();
        const selected = getSelectedRecords();
        if (selected.length) exportForBabel(selected);
      });
      shadow.getElementById("all").addEventListener("click", selectAll);
      resetButton.addEventListener("click", resetSelection);
      shadow.getElementById("cancel").addEventListener("click", () => {
        cancel();
        showToast("Message selection canceled.", false);
      });

      document.addEventListener("click", handleMessageClick, true);
      document.addEventListener("keydown", handleKeydown, true);
      decorateRecords();

      observer = new MutationObserver(scheduleRefresh);
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    function handleMessageClick(event) {
      if (!(event.target instanceof Node) || host?.contains(event.target)) {
        return;
      }

      const index = records.findIndex(
        (record) => record.root === event.target || record.root.contains(event.target)
      );
      if (index < 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (anchorKey === null) {
        anchorKey = recordKeys[index];
      }
      endKey = recordKeys[index];
      updateSelectionDisplay();
    }

    function handleKeydown(event) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
        event.composedPath().some(isEditableTarget)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        showToast("Message selection canceled.", false);
        return;
      }
      if (
        event.composedPath().includes(host) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      if (event.key === "Enter" && getSelectedRecords().length > 0) {
        event.preventDefault();
        void copySelected();
      }
    }

    function isEditableTarget(target) {
      return Boolean(
        target instanceof Element &&
          (target.matches('input, textarea, select, [role="textbox"], [role="combobox"]') || target.isContentEditable)
      );
    }

    function selectAll() {
      if (records.length === 0) {
        return;
      }
      anchorKey = recordKeys[0];
      endKey = recordKeys[recordKeys.length - 1];
      updateSelectionDisplay();
    }

    function resetSelection() {
      anchorKey = null;
      endKey = null;
      updateSelectionDisplay();
    }

    async function copySelected(save = false) {
      refreshRecords();
      const selectedRecords = getSelectedRecords();
      if (selectedRecords.length === 0) {
        showToast("Select at least one message before exporting.", true);
        return;
      }

      try {
        const conversation = extractConversation(adapter, selectedRecords);
        if (save) {
          saveMarkdown(conversation.markdown);
        } else {
          await writeClipboard(conversation.markdown);
        }
        cancel();
        const messageLabel = conversation.count === 1 ? "message" : "messages";
        showToast(
          save
            ? `Markdown download started (${conversation.count} selected ${messageLabel}). Import the .md file in Babel.`
            : `Copied ${conversation.count} selected ${messageLabel} as Markdown.`,
          false
        );
        return { action: save ? "saved-message-range" : "copied-message-range", count: conversation.count };
      } catch (error) {
        console.error("David:", error);
        showToast(getErrorMessage(error), true);
        return { ok: false, error: getErrorMessage(error) };
      }
    }

    function getSelectedRecords() {
      if (anchorKey === null || endKey === null) {
        return [];
      }
      const anchorIndex = recordKeys.indexOf(anchorKey);
      const endIndex = recordKeys.indexOf(endKey);
      if (anchorIndex < 0 || endIndex < 0) {
        return [];
      }
      const first = Math.min(anchorIndex, endIndex);
      const last = Math.max(anchorIndex, endIndex);
      return records.slice(first, last + 1);
    }

    function makeRecordKeys(sourceRecords) {
      return sourceRecords.map((record, index) =>
        typeof record.key === "string" ? record.key : `${record.role}:${index}`
      );
    }

    function decorateRecords() {
      for (const record of records) {
        record.root.setAttribute(SELECTABLE_ATTRIBUTE, "true");
      }
      updateSelectionDisplay();
    }

    function updateSelectionDisplay() {
      const selectedRecords = getSelectedRecords();
      const selectedRoots = new Set(selectedRecords.map((record) => record.root));
      const anchorIndex = anchorKey === null ? -1 : recordKeys.indexOf(anchorKey);

      records.forEach((record, index) => {
        setStateAttribute(
          record.root,
          SELECTED_ATTRIBUTE,
          selectedRoots.has(record.root)
        );
        setStateAttribute(record.root, ANCHOR_ATTRIBUTE, index === anchorIndex);
      });

      if (countLabel) {
        countLabel.textContent =
          selectedRecords.length === 0
            ? "No messages selected"
            : `${selectedRecords.length} ${
                selectedRecords.length === 1 ? "message" : "messages"
              } selected`;
      }
      if (copyButton) {
        copyButton.disabled = selectedRecords.length === 0;
      }
      if (saveButton) {
        saveButton.disabled = selectedRecords.length === 0;
      }
      if (archiveButton) {
        archiveButton.disabled = selectedRecords.length === 0;
      }
      if (resetButton) {
        resetButton.disabled = anchorKey === null;
      }
    }

    function setStateAttribute(element, attribute, isActive) {
      if (isActive) {
        element.setAttribute(attribute, "true");
      } else {
        element.removeAttribute(attribute);
      }
    }

    function scheduleRefresh() {
      if (refreshTimer !== null) {
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshRecords();
      }, 100);
    }

    function refreshRecords() {
      clearRecordAttributes(records);
      records = getConversationRecords(adapter);
      recordKeys = makeRecordKeys(records);
      if (!recordKeys.includes(anchorKey)) {
        anchorKey = null;
      }
      if (!recordKeys.includes(endKey)) {
        endKey = anchorKey;
      }
      decorateRecords();
    }

    function clearRecordAttributes(sourceRecords) {
      for (const record of sourceRecords) {
        record.root.removeAttribute(SELECTABLE_ATTRIBUTE);
        record.root.removeAttribute(SELECTED_ATTRIBUTE);
        record.root.removeAttribute(ANCHOR_ATTRIBUTE);
      }
    }

    function cancel() {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      observer?.disconnect();
      observer = null;
      document.removeEventListener("click", handleMessageClick, true);
      document.removeEventListener("keydown", handleKeydown, true);
      clearRecordAttributes(records);
      host?.remove();
      style?.remove();
      host = null;
      style = null;
      if (messageSelectionController === controller) {
        messageSelectionController = null;
      }
    }

    const controller = { start, cancel, copySelected,
      selectedRecords() { refreshRecords(); return getSelectedRecords(); } };
    return controller;
  }

  function getChatGPTMessages() {
    const messageSelector = [
      CHATGPT_MESSAGE_SELECTOR,
      CHATGPT_USER_BODY_SELECTOR,
      CHATGPT_ASSISTANT_BODY_SELECTOR
    ].join(",");
    return Array.from(document.querySelectorAll(messageSelector))
      .filter((root) => !root.parentElement?.closest(messageSelector))
      .map((root) => {
        const role = root.getAttribute("data-message-author-role") ||
          (root.matches(CHATGPT_USER_BODY_SELECTOR) ? "user" : "assistant");
        const selectors =
          role === "assistant"
            ? [CHATGPT_ASSISTANT_BODY_SELECTOR, ".markdown", ".prose", "[data-message-content]"]
            : [CHATGPT_USER_BODY_SELECTOR, '[class*="whitespace-pre-wrap"]', "[data-message-content]"];
        return {
          root,
          role,
          key: getChatGPTMessageKey(root, role),
          content: findContentRoot(root, selectors, "[data-message-author-role]")
        };
      });
  }

  function getGeminiMessages() {
    return Array.from(document.querySelectorAll("user-query, model-response")).map(
      (root) => {
        const role = root.tagName === "USER-QUERY" ? "user" : "assistant";
        const selectors =
          role === "user"
            ? [".query-text", ".query-content", "user-query-content"]
            : [
                ".markdown-main-panel",
                ".model-response-text",
                ".markdown",
                "message-content"
              ];
        return {
          root,
          role,
          key: root.id ? `gemini:${root.id}` : root,
          content: findContentRoot(root, selectors)
        };
      }
    );
  }

  function getClaudeMessages() {
    const userRoots = Array.from(
      document.querySelectorAll('[data-testid="user-message"]')
    );
    const assistantSelectorGroups = [
      '[data-testid="assistant-message"]',
      '[data-testid="assistant-message-content"]',
      ".font-claude-response",
      ".font-claude-message"
    ];
    let assistantRoots = [];

    for (const selector of assistantSelectorGroups) {
      const matches = Array.from(document.querySelectorAll(selector));
      if (matches.length > 0) {
        assistantRoots = matches;
        break;
      }
    }

    const records = [
      ...userRoots.map((root) => ({
        root,
        role: "user",
        key: root,
        content: findContentRoot(root, [
          '[data-testid="user-message-content"]',
          '[class*="whitespace-pre-wrap"]'
        ])
      })),
      ...assistantRoots.map((root) => ({
        root,
        role: "assistant",
        key: root,
        content: findContentRoot(root, [
          '[data-testid="assistant-message-content"]',
          ".font-claude-response",
          ".font-claude-message",
          ".prose",
          ".markdown"
        ])
      }))
    ];

    return records.sort(compareMessageOrder);
  }

  function compareMessageOrder(left, right) {
    if (left.root === right.root) {
      return 0;
    }
    return left.root.compareDocumentPosition(right.root) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1;
  }

  function getChatGPTMessageKey(element, role) {
    const messageId = element.getAttribute("data-message-id") ||
      element.closest("[data-chatgpt-selection-message-id]")?.getAttribute("data-chatgpt-selection-message-id") ||
      element.querySelector("[data-dil-source-message-id]")?.getAttribute("data-dil-source-message-id");
    if (messageId) {
      return `message:${messageId}`;
    }

    const unit = element.closest("[data-chatgpt-search-unit-key]");
    const messageIds = new Set((unit?.getAttribute("data-chatgpt-search-message-ids") || "").split(/\s+/).filter(Boolean));
    if (messageIds.size === 1) {
      return `message:${Array.from(messageIds)[0]}`;
    }
    if (unit?.getAttribute("data-chatgpt-search-unit-key")) {
      return `unit:${unit.getAttribute("data-chatgpt-search-unit-key")}`;
    }

    const turn = element.closest('[data-testid^="conversation-turn-"], [data-turn-key]');
    const turnId = turn?.getAttribute("data-testid") || turn?.getAttribute("data-turn-key");
    if (turnId) {
      return `turn:${role}:${turnId}`;
    }

    return element;
  }

  function isRendered(element) {
    if (element.closest('[hidden], [aria-hidden="true"]')) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function findContentRoot(messageElement, selectors, ownerSelector = null) {
    for (const selector of selectors) {
      if (messageElement.matches(selector) && hasMeaningfulContent(messageElement)) {
        return messageElement;
      }

      const matches = Array.from(messageElement.querySelectorAll(selector));
      const match = matches.find(
        (candidate) =>
          (!ownerSelector || candidate.closest(ownerSelector) === messageElement) &&
          hasMeaningfulContent(candidate)
      );

      if (match) {
        return match;
      }
    }

    return messageElement;
  }

  function hasMeaningfulContent(element) {
    return Boolean(
      element.textContent?.trim() ||
        element.matches(MATH_SELECTOR) ||
        element.querySelector(`pre, code, table, img, ${MATH_SELECTOR}`)
    );
  }

  function extractUserText(element) {
    return elementToMarkdown(element, { headingOffset: 2, preserveTextNewlines: true });
  }

  function elementToMarkdown(element, options = {}) {
    const context = {
      headingOffset: Number(options.headingOffset) || 0,
      preserveTextNewlines: options.preserveTextNewlines === true,
      archiveAssets: options.archiveAssets === true
    };
    const rendered = renderChildren(element, context);
    return cleanMarkdown(rendered);
  }

  function renderChildren(element, context) {
    return Array.from(element.childNodes, (node) => renderNode(node, context)).join("");
  }

  function renderNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || "";
      return context.preserveTextNewlines
        ? normalizeNewlines(text).split("\n")
          .map((line) => escapeText(line, false))
          .map((line, index, lines) => line.trim() && lines[index + 1]?.trim() ? `${line}\\` : line)
          .join("\n")
        : escapeText(text);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tag = element.tagName;

    const math = renderMath(element, context);
    if (math !== null) {
      return math;
    }

    if (shouldSkipElement(element)) {
      return "";
    }

    switch (tag) {
      case "BR":
        return context.inTable ? "\n" : "\\\n";
      case "P":
        return `\n\n${renderChildren(element, context).trim()}\n\n`;
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return renderHeading(element, context);
      case "STRONG":
      case "B":
        return wrapInline("**", renderChildren(element, context));
      case "EM":
      case "I":
        return wrapInline("*", renderChildren(element, context));
      case "DEL":
      case "S":
      case "STRIKE":
        return wrapInline("~~", renderChildren(element, context));
      case "A":
        return renderLink(element, context);
      case "PRE":
        return renderCodeBlock(element);
      case "CODE":
        return renderInlineCode(element.textContent || "", context);
      case "UL":
      case "OL":
        return `\n\n${renderList(element, 0, context)}\n\n`;
      case "LI":
        return renderChildren(element, context);
      case "BLOCKQUOTE":
        return renderBlockquote(element, context);
      case "TABLE":
        return renderTable(element, context);
      case "HR":
        return "\n\n---\n\n";
      case "IMG":
        return renderImage(element, context);
      case "DIV":
      case "SECTION":
      case "ARTICLE":
        return renderContainer(element, context);
      default:
        return renderChildren(element, context);
    }
  }

  function shouldSkipElement(element) {
    return (
      SKIPPED_TAGS.has(element.tagName.toUpperCase()) ||
      Array.from(element.classList).some((name) => IGNORED_CLASS_NAMES.has(name)) ||
      element.getAttribute("aria-hidden") === "true" ||
      element.getAttribute("data-markdown-copy") === "exclude"
    );
  }

  function renderHeading(element, context) {
    const originalLevel = Number(element.tagName.slice(1));
    const level = Math.min(6, originalLevel + context.headingOffset);
    const text = renderChildren(element, context).trim();
    return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
  }

  function wrapInline(marker, content) {
    const trimmed = content.trim();
    return trimmed ? `${marker}${trimmed}${marker}` : "";
  }

  function renderLink(element, context) {
    const rawHref = element.getAttribute("href");
    const label = renderChildren(element, context).trim();

    const href = safeUrl(rawHref, ["http:", "https:", "mailto:", "tel:"]);
    return href ? `[${label || escapeText(href)}](<${href}>)` : label;
  }

  function safeUrl(rawUrl, protocols) {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, window.location.href);
      if (!protocols.includes(url.protocol)) return null;
      return url.href.replace(/[<>\\|\s]/g, (character) =>
        encodeURIComponent(character)
      );
    } catch {
      return null;
    }
  }

  function renderCodeBlock(element) {
    const code = findCodeContent(element);
    const raw = extractCodeText(code).replace(/\n$/, "");
    const language = detectCodeLanguage(code, element);
    const fence = makeFence(raw);
    return `\n\n${fence}${language}\n${raw}\n${fence}\n\n`;
  }

  function findCodeContent(pre) {
    return (
      pre.querySelector('.cm-content[role="textbox"]') ||
      pre.querySelector('[role="textbox"][aria-multiline="true"]') ||
      pre.querySelector("code") ||
      pre
    );
  }

  function extractCodeText(code) {
    const editorLines = Array.from(code.children).filter(
      (child) => child.classList.contains("cm-line") || child.hasAttribute("data-code-line")
    );
    if (editorLines.length > 0) {
      return editorLines
        .map((line) => normalizeNewlines(line.textContent || ""))
        .join("\n");
    }

    const raw = normalizeNewlines(code.textContent || "");
    if (raw.includes("\n")) {
      return raw;
    }

    const rendered = normalizeNewlines(code.innerText || "");
    return rendered.includes("\n") ? rendered : raw;
  }

  function detectCodeLanguage(code, pre) {
    const dataLanguage = [
      code.getAttribute("data-language"),
      pre.getAttribute("data-language")
    ].find((candidate) => /^[\w#+.-]+$/i.test(candidate || ""));
    if (dataLanguage) {
      return dataLanguage;
    }

    const candidates = [
      ...Array.from(code.classList),
      ...Array.from(pre.classList)
    ].filter(Boolean);

    for (const candidate of candidates) {
      const match = String(candidate).match(/^(?:language-|lang-)([\w#+.-]+)$/i);
      if (match) {
        return match[1];
      }
    }

    return "";
  }

  function makeFence(code) {
    const runs = code.match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return "`".repeat(Math.max(3, longest + 1));
  }

  function renderInlineCode(rawText, context = {}) {
    const normalized = normalizeNewlines(rawText).replace(/\n+/g, " ");
    const text = context.inTable ? normalized.replace(/\|/g, "\\|") : normalized;
    if (!text) {
      return "``";
    }

    const runs = text.match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    const fence = "`".repeat(Math.max(1, longest + 1));
    const needsPadding = /^\s|\s$|^`|`$/.test(text);
    const padding = needsPadding ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
  }

  function renderList(list, _depth, context) {
    const ordered = list.tagName === "OL";
    const parsedStart = Number.parseInt(list.getAttribute("start") || "1", 10);
    const start = ordered && Number.isFinite(parsedStart) ? parsedStart : 1;
    const items = Array.from(list.children).filter((child) => child.tagName === "LI");
    const lines = [];
    let number = start;

    items.forEach((item) => {
      if (ordered && item.hasAttribute("value")) {
        const value = Number.parseInt(item.getAttribute("value"), 10);
        if (Number.isFinite(value)) number = value;
      }
      const body = cleanMarkdown(renderChildren(item, context));
      const marker = ordered ? `${number++}.` : "-";
      const indent = " ".repeat(marker.length + 1);
      const bodyLines = body.split("\n");
      const checkbox = Array.from(item.querySelectorAll('input[type="checkbox"]'))
        .find((input) => input.closest("li") === item);
      const task = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";

      lines.push(`${marker} ${task}${bodyLines[0] || ""}`.trimEnd());
      for (const continuation of bodyLines.slice(1)) {
        lines.push(continuation ? `${indent}${continuation}` : "");
      }
    });

    return lines.join("\n").trimEnd();
  }

  function renderBlockquote(element, context) {
    const content = cleanMarkdown(renderChildren(element, context));
    if (!content) {
      return "";
    }

    return `\n\n${content
      .split("\n")
      .map((line) => `> ${line}`.trimEnd())
      .join("\n")}\n\n`;
  }

  function renderTable(table, context) {
    const rows = Array.from(table.rows).map((row) =>
      Array.from(row.cells).map((cell) => {
        const content = cleanMarkdown(renderChildren(cell, { ...context, inTable: true }))
          .replace(/\n+/g, "<br>")
          .trim();
        return content;
      })
    );

    if (rows.length === 0) {
      return "";
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => [
      ...row,
      ...Array(Math.max(0, columnCount - row.length)).fill("")
    ]);
    const header = normalizedRows[0];
    const separator = Array(columnCount).fill("---");
    const body = normalizedRows.slice(1);
    const markdownRows = [header, separator, ...body].map(
      (row) => `| ${row.join(" | ")} |`
    );

    return `\n\n${markdownRows.join("\n")}\n\n`;
  }

  function renderImage(element, context = {}) {
    const alt = (element.getAttribute("alt") || "").trim();
    const asset = element.getAttribute("data-david-archive-asset");
    if (context.archiveAssets && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(asset || "")) {
      return `![${escapeText(alt)}](assets/${asset})`;
    }
    const source = element.currentSrc || element.getAttribute("src") || "";
    const url = safeUrl(source, ["http:", "https:"]);
    return url
      ? `![${escapeText(alt)}](<${url}>)`
      : `&#91;Image unavailable${alt ? `: ${escapeText(alt)}` : ""}&#93;`;
  }

  function renderContainer(element, context) {
    const content = renderChildren(element, context);
    const hasBlockChild = Array.from(element.children).some((child) =>
      BLOCK_TAGS.has(child.tagName)
    );
    return hasBlockChild || !content.trim() ? content : `${content}\n`;
  }

  function renderMath(element, context = {}) {
    if (!element.matches(MATH_SELECTOR)) {
      return null;
    }

    const tex = normalizeMathSource(
      extractMathSource(element) || extractMathMlSource(element)
    );
    if (!tex) {
      return null;
    }
    if (context.inTable) {
      return `\\(${tex.replace(/\n+/g, " ")}\\)`;
    }

    // `\(...\)` is intentionally single-line in Babel's Markdown contract.
    // Some ChatGPT display formulas do not carry a stable display class, but
    // their TeX still spans lines (for example an underbrace expansion).
    return isDisplayMath(element) || tex.includes("\n")
      ? `\n\n\\[\n${tex}\n\\]\n\n`
      : `\\(${tex}\\)`;
  }

  function extractMathSource(element) {
    const sourceElements = [
      element,
      ...Array.from(element.querySelectorAll(MATH_SOURCE_SELECTOR))
    ];
    for (const sourceElement of sourceElements) {
      for (const attribute of MATH_SOURCE_ATTRIBUTES) {
        const value = sourceElement.getAttribute(attribute)?.trim();
        if (value) {
          return value;
        }
      }
    }

    const annotation = element.querySelector(
      'annotation[encoding*="tex" i], annotation[encoding*="latex" i], annotation-xml[encoding*="tex" i], annotation-xml[encoding*="latex" i]'
    );
    if (annotation?.textContent?.trim()) {
      return annotation.textContent;
    }

    const sourceScript = element.querySelector('script[type^="math/"]');
    if (sourceScript?.textContent?.trim()) {
      return sourceScript.textContent;
    }

    for (const sourceElement of sourceElements) {
      const altText = sourceElement.getAttribute("alttext")?.trim();
      if (altText) {
        return altText;
      }
    }

    return "";
  }

  function extractMathMlSource(element) {
    const mathElement = element.matches("math")
      ? element
      : element.querySelector("math");
    return mathElement ? mathMlNodeToTex(mathElement) : "";
  }

  function mathMlNodeToTex(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue?.replace(/\s+/g, " ").trim() || "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tagName = (element.localName || element.tagName).toLowerCase();
    const children = Array.from(element.children);
    const childTex = (index) => mathMlNodeToTex(children[index]);
    const joinedChildren = () => children.map(mathMlNodeToTex).join("");

    switch (tagName) {
      case "math":
      case "mrow":
      case "mstyle":
      case "mpadded":
      case "mphantom":
      case "menclose":
        return joinedChildren();
      case "semantics": {
        const presentation = children.find(
          (child) => !["annotation", "annotation-xml"].includes(
            (child.localName || child.tagName).toLowerCase()
          )
        );
        return presentation ? mathMlNodeToTex(presentation) : "";
      }
      case "mi":
        return mathMlIdentifierToTex(element.textContent || "");
      case "mn":
        return (element.textContent || "").trim();
      case "mo":
        return mathMlOperatorToTex(element.textContent || "");
      case "mtext":
        return `\\text{${escapeTexText(element.textContent || "")}}`;
      case "mspace":
      case "none":
        return "";
      case "msup":
        return `${texAtom(childTex(0))}^{${childTex(1)}}`;
      case "msub":
        return `${texAtom(childTex(0))}_{${childTex(1)}}`;
      case "msubsup":
        return `${texAtom(childTex(0))}_{${childTex(1)}}^{${childTex(2)}}`;
      case "mfrac":
        return `\\frac{${childTex(0)}}{${childTex(1)}}`;
      case "msqrt":
        return `\\sqrt{${joinedChildren()}}`;
      case "mroot":
        return `\\sqrt[${childTex(1)}]{${childTex(0)}}`;
      case "mfenced":
        return mathMlFencedToTex(element, children);
      case "mover":
        return mathMlOverToTex(childTex(0), childTex(1));
      case "munder":
        return `\\underset{${childTex(1)}}{${childTex(0)}}`;
      case "munderover":
        return `\\overset{${childTex(2)}}{\\underset{${childTex(1)}}{${childTex(0)}}}`;
      case "mtable":
        return `\\begin{matrix}${children.map(mathMlTableRowToTex).join("\\\\")}\\end{matrix}`;
      case "mtr":
      case "mlabeledtr":
        return mathMlTableRowToTex(element);
      case "mtd":
        return joinedChildren();
      default:
        return joinedChildren() || (element.textContent || "").trim();
    }
  }

  function mathMlTableRowToTex(row) {
    return Array.from(row.children)
      .filter((cell) => (cell.localName || cell.tagName).toLowerCase() === "mtd")
      .map(mathMlNodeToTex)
      .join(" & ");
  }

  function mathMlFencedToTex(element, children) {
    const opening = mathMlFenceToTex(element.getAttribute("open") ?? "(");
    const closing = mathMlFenceToTex(element.getAttribute("close") ?? ")");
    const separators = (element.getAttribute("separators") ?? ",")
      .replace(/\s+/g, "")
      .split("")
      .filter(Boolean);
    const values = children.map(mathMlNodeToTex);
    const body = values.map((value, index) => {
      if (index === 0) return value;
      const separator = separators[Math.min(index - 1, separators.length - 1)] ?? ",";
      return `${mathMlOperatorToTex(separator)}${value}`;
    }).join("");
    return `\\left${opening}${body}\\right${closing}`;
  }

  function mathMlFenceToTex(value) {
    if (value === "{") return "\\{";
    if (value === "}") return "\\}";
    return value;
  }

  function mathMlOverToTex(base, over) {
    const accents = new Map([
      ["^", "hat"],
      ["~", "tilde"],
      ["¯", "bar"],
      ["→", "vec"],
      [".", "dot"],
      ["¨", "ddot"]
    ]);
    const command = accents.get(over);
    return command ? `\\${command}{${base}}` : `\\overset{${over}}{${base}}`;
  }

  function mathMlIdentifierToTex(value) {
    const identifier = value.replace(/\s+/g, "").trim();
    const symbols = new Map([
      ["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"],
      ["ε", "\\epsilon"], ["ζ", "\\zeta"], ["η", "\\eta"], ["θ", "\\theta"],
      ["ι", "\\iota"], ["κ", "\\kappa"], ["λ", "\\lambda"], ["μ", "\\mu"],
      ["ν", "\\nu"], ["ξ", "\\xi"], ["π", "\\pi"], ["ρ", "\\rho"], ["σ", "\\sigma"],
      ["τ", "\\tau"], ["υ", "\\upsilon"], ["φ", "\\phi"], ["χ", "\\chi"], ["ψ", "\\psi"],
      ["ω", "\\omega"], ["Γ", "\\Gamma"], ["Δ", "\\Delta"], ["Θ", "\\Theta"],
      ["Λ", "\\Lambda"], ["Ξ", "\\Xi"], ["Π", "\\Pi"], ["Σ", "\\Sigma"], ["Φ", "\\Phi"],
      ["Ψ", "\\Psi"], ["Ω", "\\Omega"]
    ]);
    if (symbols.has(identifier)) {
      return symbols.get(identifier);
    }

    const operators = new Set([
      "arccos", "arcsin", "arctan", "arg", "cos", "cosh", "cot", "coth", "csc", "deg",
      "det", "dim", "exp", "gcd", "hom", "inf", "ker", "lg", "lim", "liminf", "limsup",
      "ln", "log", "max", "min", "Pr", "sec", "sin", "sinh", "sup", "tan", "tanh"
    ]);
    if (operators.has(identifier)) {
      return `\\${identifier} `;
    }
    return identifier.replace(/[\\{}_%&#$]/g, (character) =>
      character === "\\" ? "\\backslash " : `\\${character}`
    );
  }

  function mathMlOperatorToTex(value) {
    const operator = value.replace(/\s+/g, "").trim();
    const operators = new Map([
      ["−", "-"], ["–", "-"], ["×", "\\times "], ["÷", "\\div "], ["·", "\\cdot "],
      ["⋅", "\\cdot "], ["∗", "*"], ["≠", "\\ne "], ["≤", "\\le "], ["≥", "\\ge "],
      ["≈", "\\approx "], ["≃", "\\simeq "], ["≡", "\\equiv "], ["±", "\\pm "], ["∓", "\\mp "],
      ["∞", "\\infty "], ["∑", "\\sum "], ["∏", "\\prod "], ["∫", "\\int "], ["∂", "\\partial "],
      ["∇", "\\nabla "], ["∈", "\\in "], ["∉", "\\notin "], ["⊂", "\\subset "], ["⊆", "\\subseteq "],
      ["∪", "\\cup "], ["∩", "\\cap "], ["∧", "\\land "], ["∨", "\\lor "], ["¬", "\\neg "],
      ["→", "\\to "], ["←", "\\leftarrow "], ["↔", "\\leftrightarrow "], ["⇒", "\\Rightarrow "],
      ["⇔", "\\Leftrightarrow "], ["′", "'"], ["″", "''"], ["‴", "'''"], ["…", "\\ldots "]
    ]);
    return operators.get(operator) ?? operator.replace(/[\\{}_%&#$]/g, (character) =>
      character === "\\" ? "\\backslash " : `\\${character}`
    );
  }

  function texAtom(value) {
    return value ? `{${value}}` : "{}";
  }

  function escapeTexText(value) {
    return value
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\{}_%&#$]/g, (character) =>
        character === "\\" ? "\\textbackslash{}" : `\\${character}`
      );
  }

  function normalizeMathSource(source) {
    let tex = normalizeNewlines(source || "")
      .replace(/[\u200b-\u200d\u2060]/g, "")
      .trim();
    const delimiterPairs = [
      ["$$", "$$"],
      ["\\[", "\\]"],
      ["\\(", "\\)"],
      ["$", "$"]
    ];

    for (const [opening, closing] of delimiterPairs) {
      if (
        tex.length > opening.length + closing.length &&
        tex.startsWith(opening) &&
        tex.endsWith(closing)
      ) {
        tex = tex.slice(opening.length, -closing.length).trim();
        break;
      }
    }

    return tex;
  }

  function isDisplayMath(element) {
    const tagName = element.tagName.toUpperCase();
    const mathStyle = element.getAttribute("data-math-style");
    const displayAttribute = element.getAttribute("display");

    return Boolean(
      element.matches(".math-block, .katex-display") ||
        mathStyle === "display" ||
        mathStyle === "block" ||
        displayAttribute === "block" ||
        (tagName === "MJX-CONTAINER" && displayAttribute === "true") ||
        element.getAttribute("data-display") === "true" ||
        element.closest(".math-block, .katex-display") !== null
    );
  }

  function escapeText(rawText, collapseWhitespace = true) {
    const normalized = rawText.replace(/\u00a0/g, " ");
    return (collapseWhitespace ? normalized.replace(/\s+/g, " ") : normalized)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/([\\`*_{}#$~|!+.=-])/g, "\\$1")
      // Backslash brackets are explicit LaTeX block delimiters in Babel.
      .replace(/\[/g, "&#91;")
      .replace(/\]/g, "&#93;");
  }

  function normalizeNewlines(value) {
    return value.replace(/\r\n?/g, "\n");
  }

  function cleanMarkdown(markdown) {
    const lines = normalizeNewlines(markdown).split("\n");
    const output = [];
    let previousWasBlank = true;
    let fence = null;

    for (const originalLine of lines) {
      const fenceMatch = originalLine.match(/^[ \t]*(?:(?:>[ \t]*)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) {
          fence = { character: marker[0], length: marker.length };
        } else if (
          marker[0] === fence.character &&
          marker.length >= fence.length
        ) {
          fence = null;
        }
        output.push(originalLine.replace(/[ \t]+$/g, ""));
        previousWasBlank = false;
        continue;
      }

      if (fence) {
        output.push(originalLine);
        continue;
      }

      const line = originalLine.replace(/[ \t]+$/g, "");
      if (!line.trim()) {
        if (!previousWasBlank) {
          output.push("");
        }
        previousWasBlank = true;
        continue;
      }

      output.push(line);
      previousWasBlank = false;
    }

    while (output.length && !output[0].trim()) {
      output.shift();
    }
    while (output.length && !output[output.length - 1].trim()) {
      output.pop();
    }

    return output.join("\n");
  }

  async function writeClipboard(text) {
    validateMarkdownSize(text);
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      Object.assign(textarea.style, {
        position: "fixed",
        left: "-9999px",
        top: "0",
        opacity: "0"
      });
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();

      if (!copied) {
        throw new Error("Chrome did not allow clipboard access.");
      }
    }
  }

  function showToast(message, isError) {
    document.getElementById(TOAST_ID)?.remove();

    const selectorPanel = document
      .getElementById(SELECTOR_HOST_ID)
      ?.shadowRoot?.querySelector(".panel");
    const selectorTop = selectorPanel?.getBoundingClientRect().top;
    const toastBottom =
      typeof selectorTop === "number"
        ? `${Math.ceil(Math.max(24, window.innerHeight - selectorTop + 12))}px`
        : "24px";

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      right: "24px",
      bottom: toastBottom,
      zIndex: "2147483647",
      maxWidth: "360px",
      padding: "12px 16px",
      borderRadius: "10px",
      background: isError ? "#991b1b" : "#166534",
      color: "#ffffff",
      font: "500 14px/1.4 system-ui, sans-serif",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.25)",
      opacity: "0",
      transform: "translateY(8px)",
      transition: "opacity 120ms ease, transform 120ms ease"
    });

    (document.body || document.documentElement).appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      setTimeout(() => toast.remove(), 150);
    }, isError ? 4500 : 2500);
  }
})();
