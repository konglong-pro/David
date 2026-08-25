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
  const CHATGPT_MESSAGE_SELECTOR =
    '[data-message-author-role="user"], [data-message-author-role="assistant"]';
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
    "[data-math-style]",
    ".math-inline",
    ".math-block",
    ".katex",
    ".katex-display",
    "math",
    "mjx-container"
  ].join(",");
  let messageSelectionController = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "david:command") {
      return false;
    }

    void handleCommand(message.command)
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
      default:
        throw new Error("David received an unknown command.");
    }
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
            <button id="all" type="button">Select all</button>
            <button id="reset" type="button" disabled>Start over</button>
            <button class="cancel" id="cancel" type="button">Cancel</button>
          </div>
        </section>
      `;
      (document.body || document.documentElement).appendChild(host);

      countLabel = shadow.getElementById("count");
      copyButton = shadow.getElementById("copy");
      resetButton = shadow.getElementById("reset");
      copyButton.addEventListener("click", () => void copySelected());
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
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        showToast("Message selection canceled.", false);
        return;
      }
      if (
        event.composedPath().includes(host) ||
        isEditableTarget(event.target) ||
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
          (target.matches("input, textarea, select") || target.isContentEditable)
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

    async function copySelected() {
      refreshRecords();
      const selectedRecords = getSelectedRecords();
      if (selectedRecords.length === 0) {
        showToast("Select at least one message before copying.", true);
        return;
      }

      try {
        const conversation = extractConversation(adapter, selectedRecords);
        await writeClipboard(conversation.markdown);
        cancel();
        const messageLabel = conversation.count === 1 ? "message" : "messages";
        showToast(
          `Copied ${conversation.count} selected ${messageLabel} as Markdown.`,
          false
        );
      } catch (error) {
        console.error("David:", error);
        showToast(getErrorMessage(error), true);
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

    const controller = { start, cancel };
    return controller;
  }

  function getChatGPTMessages() {
    return Array.from(document.querySelectorAll(CHATGPT_MESSAGE_SELECTOR)).map(
      (root) => {
        const role = root.getAttribute("data-message-author-role");
        const selectors =
          role === "assistant"
            ? [".markdown", ".prose", "[data-message-content]"]
            : ['[class*="whitespace-pre-wrap"]', "[data-message-content]"];
        return {
          root,
          role,
          key: getChatGPTMessageKey(root),
          content: findContentRoot(root, selectors, "[data-message-author-role]")
        };
      }
    );
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

  function getChatGPTMessageKey(element) {
    const messageId = element.getAttribute("data-message-id");
    if (messageId) {
      return `message:${messageId}`;
    }

    const turn = element.closest('[data-testid^="conversation-turn-"]');
    if (turn?.getAttribute("data-testid")) {
      return `turn:${turn.getAttribute("data-testid")}`;
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
    return normalizeNewlines(renderPlainTextChildren(element))
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim();
  }

  function renderPlainTextChildren(element) {
    return Array.from(element.childNodes, (node) => renderPlainTextNode(node)).join("");
  }

  function renderPlainTextNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const math = renderMath(element);
    if (math !== null) {
      return math;
    }
    if (shouldSkipElement(element)) {
      return "";
    }
    if (element.tagName === "BR") {
      return "\n";
    }

    const content = renderPlainTextChildren(element);
    return BLOCK_TAGS.has(element.tagName) || element.tagName === "LI"
      ? `${content}\n`
      : content;
  }

  function elementToMarkdown(element, options = {}) {
    const context = {
      headingOffset: Number(options.headingOffset) || 0
    };
    const rendered = renderChildren(element, context);
    return cleanMarkdown(rendered);
  }

  function renderChildren(element, context) {
    return Array.from(element.childNodes, (node) => renderNode(node, context)).join("");
  }

  function renderNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText(node.nodeValue || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tag = element.tagName;

    const math = renderMath(element);
    if (math !== null) {
      return math;
    }

    if (shouldSkipElement(element)) {
      return "";
    }

    switch (tag) {
      case "BR":
        return "\n";
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
        return renderInlineCode(element.textContent || "");
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
        return renderImage(element);
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
      element.getAttribute("aria-hidden") === "true"
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

    if (!rawHref || rawHref.startsWith("javascript:")) {
      return label;
    }

    let href;
    try {
      href = new URL(rawHref, window.location.href).href;
    } catch {
      href = rawHref;
    }

    const safeHref = href.replace(/\)/g, "\\)");
    return `[${label || escapeText(href)}](${safeHref})`;
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

  function renderInlineCode(rawText) {
    const text = normalizeNewlines(rawText).replace(/\n+/g, " ");
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

  function renderList(list, depth, context) {
    const ordered = list.tagName === "OL";
    const start = ordered ? Number(list.getAttribute("start")) || 1 : 1;
    const items = Array.from(list.children).filter((child) => child.tagName === "LI");
    const lines = [];

    items.forEach((item, index) => {
      const nestedLists = Array.from(item.children).filter(
        (child) => child.tagName === "UL" || child.tagName === "OL"
      );
      const bodyNodes = Array.from(item.childNodes).filter(
        (child) =>
          !(
            child.nodeType === Node.ELEMENT_NODE &&
            (child.tagName === "UL" || child.tagName === "OL")
          )
      );
      const body = cleanListItem(
        bodyNodes.map((child) => renderNode(child, context)).join("")
      );
      const indent = "  ".repeat(depth);
      const marker = ordered ? `${start + index}.` : "-";
      const bodyLines = body.split("\n");

      lines.push(`${indent}${marker} ${bodyLines[0] || ""}`.trimEnd());
      for (const continuation of bodyLines.slice(1)) {
        lines.push(`${indent}  ${continuation}`.trimEnd());
      }

      for (const nested of nestedLists) {
        lines.push(renderList(nested, depth + 1, context));
      }
    });

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  }

  function cleanListItem(markdown) {
    return cleanMarkdown(markdown)
      .replace(/^\s+|\s+$/g, "")
      .replace(/\n{2,}/g, "\n");
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
        const content = cleanMarkdown(renderChildren(cell, context))
          .replace(/\n+/g, "<br>")
          .replace(/\|/g, "\\|")
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

  function renderImage(element) {
    const alt = (element.getAttribute("alt") || "").trim();
    const source = element.getAttribute("src") || "";
    if (!source || source.startsWith("blob:") || source.startsWith("data:")) {
      return alt ? `[${escapeText(alt)}]` : "";
    }

    let url;
    try {
      url = new URL(source, window.location.href).href;
    } catch {
      url = source;
    }
    return `![${escapeText(alt)}](${url.replace(/\)/g, "\\)")})`;
  }

  function renderContainer(element, context) {
    const content = renderChildren(element, context);
    const hasBlockChild = Array.from(element.children).some((child) =>
      BLOCK_TAGS.has(child.tagName)
    );
    return hasBlockChild || !content.trim() ? content : `${content}\n`;
  }

  function renderMath(element) {
    if (!element.matches(MATH_SELECTOR)) {
      return null;
    }

    const tex = normalizeMathSource(
      extractMathSource(element) || extractMathFallbackText(element)
    );
    if (!tex) {
      return null;
    }

    return isDisplayMath(element) ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
  }

  function extractMathSource(element) {
    const tagName = element.tagName.toUpperCase();

    for (const attribute of ["data-math", "data-tex", "data-latex"]) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) {
        return value;
      }
    }

    const annotation = element.querySelector(
      'annotation[encoding="application/x-tex" i], annotation[encoding="application/x-latex" i], annotation[encoding="text/tex" i]'
    );
    if (annotation?.textContent?.trim()) {
      return annotation.textContent;
    }

    const accessibleMath =
      tagName === "MATH" || tagName === "MJX-CONTAINER";
    if (accessibleMath) {
      const accessibleSource =
        element.getAttribute("alttext") || element.getAttribute("aria-label");
      if (accessibleSource?.trim()) {
        return accessibleSource;
      }
    }

    const nestedAccessibleMath = element.querySelector(
      "math[alttext], math[aria-label]"
    );
    return (
      nestedAccessibleMath?.getAttribute("alttext") ||
      nestedAccessibleMath?.getAttribute("aria-label") ||
      ""
    );
  }

  function extractMathFallbackText(element) {
    const visualMath = element.querySelector(".katex-html") || element;
    return (visualMath.textContent || "")
      .replace(/[\u200b-\u200d\u2060]/g, "")
      .replace(/\s+/g, " ")
      .trim();
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

  function escapeText(rawText) {
    return rawText
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/([`*_\[\]])/g, "\\$1");
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
      const fenceMatch = originalLine.match(/^\s*(`{3,}|~{3,})/);
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
