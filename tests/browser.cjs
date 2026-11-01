"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sourceForTests } = require("./helpers.cjs");

async function main() {
  let playwright;
  try {
    playwright = require(process.env.DAVID_PLAYWRIGHT_MODULE || "playwright");
  } catch {
    throw new Error("Browser tests require an existing Playwright installation. Set DAVID_PLAYWRIGHT_MODULE to its absolute module path; no production dependency is needed.");
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.DAVID_CHROMIUM_PATH ? { executablePath: process.env.DAVID_CHROMIUM_PATH } : {})
  });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "conversation.html"), "utf8");
    const modernFixture = fs.readFileSync(path.join(__dirname, "fixtures", "chatgpt-modern.html"), "utf8");
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const body = url.pathname === "/c/synthetic" ? fixture
        : url.pathname === "/c/modern" ? modernFixture : null;
      return url.hostname === "chatgpt.com" && body !== null
        ? route.fulfill({ contentType: "text/html; charset=utf-8", body })
        : route.abort();
    });
    await page.addInitScript(() => {
      globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__davidCommandListener = listener; } } } };
      Object.defineProperty(navigator, "clipboard", { value: { async writeText(text) { globalThis.__copiedMarkdown = text; } } });
    });
    await page.goto("https://chatgpt.com/c/synthetic");
    await page.addScriptTag({ content: sourceForTests() });
    const command = (name) => page.evaluate((commandName) => new Promise((resolve) => {
      globalThis.__davidCommandListener({ type: "david:command", command: commandName }, null, resolve);
    }), name);

    const copied = await command("quick-copy");
    assert.equal(copied.ok, true);
    assert.equal(copied.count, 2);
    const markdown = await page.evaluate(() => globalThis.__copiedMarkdown);
    assert.match(markdown, /^## User\n/u);
    assert.match(markdown, /## Assistant\n/u);
    assert.match(markdown, /### Format fixture/u);
    assert.match(markdown, /\\\$5/u);
    assert.match(markdown, /&lt;script&gt;literal&lt;\/script&gt;/u);
    assert.ok(markdown.includes("&#91;&#91;literal&#93;&#93;"));
    assert.ok(markdown.includes("![Remote &#91;image&#93;](<https://example.invalid/a(b).png?key=1&v=2>)"));
    assert.ok(markdown.includes("Line one\\\nLine  two"));
    assert.ok(markdown.includes("Hard break\\\nNext line"));
    assert.match(markdown, /!\[User photo\]\(<https:\/\/example\.invalid\/user\(a\)\.png\?key=1&v=2>\)/u);
    assert.match(markdown, /\\\(x_1 \+ \\frac\{a\}\{b\}\\\)/u);
    assert.match(markdown, /\\\[\n\\begin\{aligned\}/u);
    assert.match(markdown, /9\. Ninth paragraph\\\./u);
    assert.match(markdown, /\n   - Nested before code\\\./u);
    assert.match(markdown, /Nested before code[\s\S]+Paragraph after nested list[\s\S]+````python/u);
    assert.match(markdown, /10\. Tenth paragraph\\\.\n\n    ```js\n      keepIndent\(\);\n    next\(\);\n    ```\n\n    Still the tenth item\\\./u);
    assert.match(markdown, /- \[x\] Done task\n- \[ \] Pending task/u);
    assert.match(markdown, /First<br>Second/u);
    assert.match(markdown, /Literal HTML \| &lt;br&gt;/u);
    assert.match(markdown, /left \\\| right and `a\\\|b`/u);
    assert.match(markdown, /\| Math \| \\\(\\frac\{a\}\{b\}\\\) \|/u);
    assert.ok(markdown.includes(String.raw`| Math pipe | \(|a| + \|b\|\) |`));
    assert.match(markdown, /\[Balanced URL\]\(<https:\/\/example\.invalid\/a\(b\)\?signed=1&v=two%20words>\)/u);
    assert.doesNotMatch(markdown, /javascript:/iu);
    assert.ok(markdown.includes("&#91;Image unavailable: Local image&#93;"));
    assert.equal((markdown.match(/\\\[/gu) || []).length, 1, "only the actual display formula emits a LaTeX block opening");
    assert.equal((markdown.match(/\\\]/gu) || []).length, 1, "only the actual display formula emits a LaTeX block closing");
    assert.match(markdown, /```mermaid\ngraph TD\n  A-->B\n```/u);
    assert.match(markdown, /\\\(a\\_b\+\\text\{50\\% \\& x\}\\\)/u);
    console.log("PASS real DOM conversation: roles, literal text, formulas, URLs, tables, lists, images and code");

    const downloadPromise = page.waitForEvent("download");
    const saved = await command("save-markdown");
    const download = await downloadPromise;
    assert.equal(saved.ok, true);
    assert.equal(download.suggestedFilename(), "Synthetic fixture - ChatGPT.md");
    assert.equal(fs.readFileSync(await download.path(), "utf8"), markdown);
    console.log("PASS UTF-8 Markdown download equals copied content");

    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("[data-message-author-role='assistant'] blockquote"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    assert.equal((await command("quick-copy")).action, "copied-selection");
    const selectionMarkdown = await page.evaluate(() => globalThis.__copiedMarkdown);
    assert.doesNotMatch(selectionMarkdown, /## User|## Assistant/u);
    const selectionDownloadPromise = page.waitForEvent("download");
    assert.equal((await command("save-markdown")).action, "saved-selection");
    const selectionDownload = await selectionDownloadPromise;
    assert.equal(fs.readFileSync(await selectionDownload.path(), "utf8"), selectionMarkdown);
    console.log("PASS selected page text copy and download");

    await page.evaluate(() => window.getSelection().removeAllRanges());
    assert.equal((await command("select-messages")).ok, true);
    await page.locator("[data-message-author-role='assistant'] h1").click();
    const rangeDownloadPromise = page.waitForEvent("download");
    await page.locator("#david-message-selector #save").click();
    const rangeDownload = await rangeDownloadPromise;
    const rangeMarkdown = fs.readFileSync(await rangeDownload.path(), "utf8");
    assert.match(rangeMarkdown, /^## Assistant\n/u);
    assert.doesNotMatch(rangeMarkdown, /^## User\n/u);
    assert.equal(await page.locator("#david-message-selector").count(), 0);
    console.log("PASS current message range download and selector cleanup");

    if (process.env.DAVID_FIXTURE_OUTPUT) {
      fs.writeFileSync(process.env.DAVID_FIXTURE_OUTPUT, markdown, "utf8");
      console.log(`Synthetic export: ${process.env.DAVID_FIXTURE_OUTPUT}`);
    }

    await page.goto("https://chatgpt.com/c/modern");
    await page.addScriptTag({ content: sourceForTests() });
    const modernCopy = await command("quick-copy");
    assert.equal(modernCopy.ok, true, modernCopy.error);
    assert.equal(modernCopy.count, 4, "Modern user/assistant bodies must remain separate messages.");
    const modernMarkdown = await page.evaluate(() => globalThis.__copiedMarkdown);
    assert.match(modernMarkdown, /^## User\n\nFirst question\n\n## Assistant\n/u);
    assert.match(modernMarkdown, /First response body with \*\*formatting\*\*[\s\S]+## User\n\nSecond question[\s\S]+## Assistant\n\nSecond response body/u);
    assert.match(modernMarkdown, /\\\(x_1 \+ \\frac\{a\}\{b\}\\\)/u);
    assert.match(modernMarkdown, /```js\nconst answer = 42;\n```/u);
    assert.match(modernMarkdown, /First<br>Second/u);
    assert.doesNotMatch(modernMarkdown, /Unrelated|Yesterday|ChatGPT said|Internal copy hint|Toolbar hint|Copy user|Copy answer|Hidden|Disclaimer|Unsent draft/u);
    const modernDownloadPromise = page.waitForEvent("download");
    assert.equal((await command("save-markdown")).count, 4);
    const modernDownload = await modernDownloadPromise;
    assert.equal(fs.readFileSync(await modernDownload.path(), "utf8"), modernMarkdown);
    console.log("PASS current ChatGPT message bodies: order, roles, formatting, exclusions and download");

    assert.equal((await command("select-messages")).ok, true);
    await page.getByText("First response body with", { exact: false }).click();
    await page.getByText("Second question", { exact: true }).click();
    await page.locator("#david-message-selector #copy").click();
    await page.waitForFunction(() => !document.getElementById("david-message-selector"));
    const modernRange = await page.evaluate(() => globalThis.__copiedMarkdown);
    assert.match(modernRange, /^## Assistant\n/u);
    assert.match(modernRange, /## User\n\nSecond question/u);
    assert.equal((modernRange.match(/^## (?:User|Assistant)$/gmu) || []).length, 2);
    console.log("PASS modern message selection keeps the exact cross-turn range");

    await page.evaluate(() => {
      const modernBody = document.querySelector('[data-markdown-text-style="assistant-message"]');
      const legacyWrapper = document.createElement("div");
      legacyWrapper.setAttribute("data-message-author-role", "assistant");
      legacyWrapper.setAttribute("data-message-id", "assistant-1");
      modernBody.replaceWith(legacyWrapper);
      legacyWrapper.appendChild(modernBody);
    });
    assert.equal((await command("quick-copy")).count, 4);
    assert.equal(await page.evaluate(() => globalThis.__copiedMarkdown), modernMarkdown);
    console.log("PASS mixed old/new message nodes do not duplicate or drop messages");

    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-message-id],[data-chatgpt-search-message-ids],[data-chatgpt-search-unit-key],[data-chatgpt-selection-message-id],[data-dil-source-message-id]')) {
        for (const name of ["data-message-id", "data-chatgpt-search-message-ids", "data-chatgpt-search-unit-key", "data-chatgpt-selection-message-id", "data-dil-source-message-id"]) element.removeAttribute(name);
      }
    });
    assert.equal((await command("quick-copy")).count, 4);
    assert.equal(await page.evaluate(() => globalThis.__copiedMarkdown), modernMarkdown);
    console.log("PASS turn identity fallback distinguishes user and assistant within the same turn");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
