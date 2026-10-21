"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { loadContent } = require("./helpers.cjs");

const content = loadContent();

test("plain text cannot create Markdown, HTML, Typst or LaTeX formulas", () => {
  const result = content.escapeText("# Heading <br> & $5 *x* [[note]] - + 1. ![x](url)");
  assert.equal(result, "\\# Heading &lt;br&gt; &amp; \\$5 \\*x\\* &#91;&#91;note&#93;&#93; \\- \\+ 1\\. \\!&#91;x&#93;(url)");
  assert.doesNotMatch(result, /\\\[|\\\]/u);
});

test("links retain balanced parentheses, backslashes and encoded delimiters", () => {
  assert.equal(content.safeUrl("/file(a)b?x=1&y=2#section", ["https:"]), "https://chatgpt.com/file(a)b?x=1&y=2#section");
  assert.equal(content.safeUrl("https://example.com/a%20b?q=<tag>", ["https:"]), "https://example.com/a%20b?q=%3Ctag%3E");
  assert.equal(content.safeUrl("mailto:me@example.com?subject=hello world", ["mailto:"]), "mailto:me@example.com?subject=hello%20world");
});

test("executable and unsupported link schemes are rejected case insensitively", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "file:///C:/private.txt", "vbscript:msgbox(1)"]) {
    assert.equal(content.safeUrl(href, ["http:", "https:", "mailto:", "tel:"]), null, href);
  }
});

test("nonportable images get an explicit placeholder", () => {
  const image = (src, alt) => ({ getAttribute: (name) => ({ src, alt })[name] ?? null });
  assert.equal(content.renderImage(image("blob:https://chatgpt.com/id", "Photo")), "&#91;Image unavailable: Photo&#93;");
  assert.equal(content.renderImage(image("data:image/png;base64,AA", "")), "&#91;Image unavailable&#93;");
  assert.equal(content.renderImage(image("https://example.com/a(b).png?q=1&x=2", "A [B]")), "![A &#91;B&#93;](<https://example.com/a(b).png?q=1&x=2>)");
  const placeholder = content.renderImage(image("blob:https://chatgpt.com/id", "A [B]"));
  assert.equal(placeholder, "&#91;Image unavailable: A &#91;B&#93;&#93;");
  assert.doesNotMatch(placeholder, /\\\[|\\\]/u);
});

test("filenames are usable Markdown names without path components", () => {
  assert.equal(content.markdownFilename('Test: <one>/two?*'), "Test_ _one__two__.md");
  assert.equal(content.markdownFilename(" . "), "conversation.md");
  assert.equal(content.markdownFilename("already.md"), "already.md");
  assert.equal(content.markdownFilename("中文对话"), "中文对话.md");
});

test("export size uses UTF-8 bytes and the same 10 MiB bound as Babel", () => {
  assert.equal(content.validateMarkdownSize("x".repeat(10 * 1024 * 1024)).length, 10 * 1024 * 1024);
  assert.throws(() => content.validateMarkdownSize("x".repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
  assert.throws(() => content.validateMarkdownSize("汉".repeat(3_500_000)), /10 MiB/);
});

test("MathML fallback escapes TeX special characters exactly once", () => {
  assert.equal(content.mathMlIdentifierToTex("a_b"), "a\\_b");
  assert.equal(content.mathMlIdentifierToTex("50%"), "50\\%");
  assert.equal(content.escapeTexText("50% & x_{a}"), "50\\% \\& x\\_\\{a\\}");
  assert.equal(content.escapeTexText("\\"), "\\textbackslash{}");
  assert.equal(content.normalizeMathSource("\\[\nx^2\n\\]"), "x^2");
});

test("code fences grow beyond embedded fences and cleanup preserves code whitespace", () => {
  assert.equal(content.makeFence("text ``` and `````"), "``````");
  assert.equal(content.cleanMarkdown("\n\n```js\n  value  \n\n\n```\n\n"), "```js\n  value  \n\n\n```");
  assert.equal(content.cleanMarkdown("10. ```js\n      value  \n\n\n    ```"), "10. ```js\n      value  \n\n\n    ```");
  assert.equal(content.cleanMarkdown("> ```js\n> value  \n>\n> ```"), "> ```js\n> value  \n>\n> ```");
});

test("the extension keeps minimal permissions and exposes the download command", async () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "clipboardWrite"]);
  assert.equal(manifest.host_permissions, undefined);
  const messages = [];
  const context = {
    chrome: {
      commands: { onCommand: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
      tabs: {
        query: async () => [{ id: 12, url: "https://chatgpt.com/c/synthetic" }],
        sendMessage: async (_id, message) => { messages.push(message); return { ok: true }; }
      },
      scripting: { executeScript: async () => {} }
    }, URL
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8") + "\nglobalThis.run = runActiveTabCommand;", context);
  await context.run("save-markdown");
  assert.equal(messages[0].command, "save-markdown");
  await assert.rejects(context.run("unknown"), /unknown command/);
});
