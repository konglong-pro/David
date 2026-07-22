(() => {
  "use strict";

  const TOAST_ID = "david-copy-markdown-toast";
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

  void main();

  async function main() {
    try {
      const selectionMarkdown = extractSelectionMarkdown();
      if (selectionMarkdown) {
        await writeClipboard(selectionMarkdown);
        showToast("Copied selection as Markdown.", false);
        return;
      }

      const adapter = getConversationAdapter();
      if (!adapter) {
        throw new Error("Select some content before clicking David.");
      }

      const conversation = extractConversation(adapter);
      await writeClipboard(conversation.markdown);
      showToast(`Copied ${conversation.count} messages as Markdown.`, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Copy failed.";
      console.error("David:", error);
      showToast(message, true);
    }
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
    if (!selectedText.trim()) {
      return null;
    }

    const container = document.createElement("div");
    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (index > 0) {
        container.appendChild(document.createElement("br"));
      }
      container.appendChild(selection.getRangeAt(index).cloneContents());
    }

    return elementToMarkdown(container, { headingOffset: 0 }) || selectedText.trim();
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

  function extractConversation(adapter) {
    const messages = [];
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
        element.querySelector("pre, code, table, img, .katex, math")
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
      SKIPPED_TAGS.has(element.tagName) ||
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
    const code = element.querySelector("code") || element;
    const raw = normalizeNewlines(code.textContent || "").replace(/\n$/, "");
    const language = detectCodeLanguage(code, element);
    const fence = makeFence(raw);
    return `\n\n${fence}${language}\n${raw}\n${fence}\n\n`;
  }

  function detectCodeLanguage(code, pre) {
    const candidates = [
      code.getAttribute("data-language"),
      pre.getAttribute("data-language"),
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
    const isKatex = element.classList.contains("katex");
    const isDisplay =
      element.classList.contains("katex-display") ||
      element.getAttribute("data-math-style") === "display";

    if (!isKatex && !isDisplay) {
      return null;
    }

    const annotation = element.querySelector(
      'annotation[encoding="application/x-tex"]'
    );
    const tex = annotation?.textContent?.trim();
    if (!tex) {
      return null;
    }

    return isDisplay ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
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

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
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
