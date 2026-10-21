"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const exported = [
  "elementToMarkdown", "extractUserText", "extractConversation", "getConversationAdapter",
  "renderList", "renderImage", "renderLink", "renderTable", "safeUrl", "escapeText",
  "markdownFilename", "validateMarkdownSize", "normalizeMathSource", "mathMlIdentifierToTex",
  "escapeTexText", "makeFence", "cleanMarkdown"
];

function sourceForTests() {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  return source.replace(/\}\)\(\);\s*$/, `globalThis.__davidTest = { ${exported.join(", ")} };})();`);
}

function loadContent() {
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    TextEncoder,
    URL,
    window: { location: { href: "https://chatgpt.com/c/synthetic", hostname: "chatgpt.com" } },
    document: { title: "Synthetic conversation" }
  };
  vm.createContext(context);
  vm.runInContext(sourceForTests(), context);
  return context.__davidTest;
}

module.exports = { loadContent, sourceForTests };
