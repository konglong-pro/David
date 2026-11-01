"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const commandNames = ["quick-copy", "select-messages", "save-markdown", "export-babel"];

async function main() {
  let playwright;
  try { playwright = require(process.env.DAVID_PLAYWRIGHT_MODULE || "playwright"); }
  catch { throw new Error("Set DAVID_PLAYWRIGHT_MODULE to an existing Playwright installation; no dependency is installed by this check."); }
  const launch = { headless: true,
    ...(process.env.DAVID_CHROMIUM_PATH ? { executablePath: process.env.DAVID_CHROMIUM_PATH } : {}) };
  const browser = await playwright.chromium.launch(launch);
  try {
    await testPopup(browser);
    await testContent(browser);
  } finally { await browser.close(); }
  await testExtension(playwright, launch);
}

async function popupPage(browser, options = {}) {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(source("popup.html").replace(/<script src="popup.js"><\/script>/u, ""));
  await page.addStyleTag({ content: source("popup.css") });
  await page.evaluate((settings) => {
    globalThis.__messages = []; globalThis.__opened = []; globalThis.__closed = 0;
    window.close = () => { globalThis.__closed++; };
    globalThis.chrome = {
      commands: { async getAll() {
        if (settings.failBindings) throw new Error("Synthetic API unavailable");
        return settings.bindings || [];
      } },
      tabs: { async create(options) { globalThis.__opened.push(options); } },
      runtime: { async sendMessage(message) { globalThis.__messages.push(message); return { ok: true }; } }
    };
  }, options);
  await page.addScriptTag({ content: source("popup.js") });
  await page.waitForFunction(() => ![...document.querySelectorAll("[data-command-shortcut]")].some((label) => label.textContent === "Loading…"));
  return page;
}

async function testPopup(browser) {
  const bindings = commandNames.map((name, index) => ({ name, shortcut: index === 2 ? "" : `Ctrl+Shift+${["1", "2", "3", "4"][index]}` }));
  const page = await popupPage(browser, { bindings });
  try {
    assert.equal(await page.locator('[data-command-shortcut="quick-copy"]').innerText(), "Ctrl+Shift+1");
    assert.equal(await page.locator('[data-command-shortcut="save-markdown"]').innerText(), "Unassigned");
    assert.match(await page.locator("#shortcut-status").innerText(), /unassigned/u);
    await page.evaluate(() => {
      const input = document.createElement("input"); input.id = "typing"; document.body.append(input);
      const shadow = document.createElement("div"); shadow.id = "shadow";
      shadow.attachShadow({ mode: "open" }).innerHTML = '<div contenteditable="true">Draft</div>';
      document.body.append(shadow);
      const role = document.createElement("div"); role.id = "role"; role.role = "textbox"; role.tabIndex = 0; document.body.append(role);
      const dispatch = (target, key, extra = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...extra }));
      for (const target of [input, shadow.shadowRoot.firstChild, role]) {
        dispatch(target, "b"); dispatch(target, "c"); dispatch(target, "s"); dispatch(target, "d"); dispatch(target, "Escape");
      }
      for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) dispatch(document.body, "b", extra);
      const prevented = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true });
      prevented.preventDefault(); document.body.dispatchEvent(prevented);
      dispatch(document.body, "Escape", { isComposing: true });
      dispatch(document.body, "Escape", { repeat: true });
    });
    assert.deepEqual(await page.evaluate(() => globalThis.__messages), []);
    assert.equal(await page.evaluate(() => globalThis.__closed), 0);
    await page.locator("#configure-shortcuts").click();
    assert.deepEqual(await page.evaluate(() => globalThis.__opened), [{ url: "chrome://extensions/shortcuts" }]);
    assert.equal(await page.evaluate(() => globalThis.__closed), 1);
  } finally { await page.close(); }
  const unavailable = await popupPage(browser, { failBindings: true });
  assert.deepEqual(await unavailable.locator("[data-command-shortcut]").allTextContents(), Array(4).fill("Unavailable"));
  await unavailable.close();
  for (const [key, command] of [["b", "export-babel"], ["c", "quick-copy"], ["s", "select-messages"], ["d", "save-markdown"]]) {
    const local = await popupPage(browser, { bindings });
    await local.keyboard.press(key);
    assert.deepEqual(await local.evaluate(() => globalThis.__messages), [{ type: "david:popup-command", command }]);
    assert.equal(await local.evaluate(() => globalThis.__closed), 1);
    await local.close();
  }
  console.log("PASS popup actual/custom/unassigned bindings, settings, B/C/S/D and editable/IME guards");
}

async function testContent(browser) {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.route("**/*", (route) => route.request().url() === "https://chatgpt.com/c/shortcuts"
    ? route.fulfill({ contentType: "text/html", body: source("tests/fixtures/chatgpt-modern.html") }) : route.abort());
  await page.addInitScript(() => {
    globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__listener = listener; } } } };
    globalThis.__writes = []; globalThis.__captures = [];
    Object.defineProperty(navigator, "clipboard", { value: { async writeText(text) {
      globalThis.__writes.push(text);
      if (globalThis.__blockClipboard) await new Promise((resolve) => { globalThis.__releaseClipboard = resolve; });
    } } });
    globalThis.__davidArchiveV1 = { captureAndSave(options) {
      globalThis.__captures.push(options.records.map((record) => ({ role: record.role, text: record.root.textContent })));
      return new Promise((resolve) => { globalThis.__finishCapture = () => resolve({ assets: 0, warnings: 0 }); });
    } };
  });
  await page.goto("https://chatgpt.com/c/shortcuts");
  await page.addScriptTag({ content: source("content.js") });
  const command = (name) => page.evaluate((value) => new Promise((resolve) => {
    globalThis.__listener({ type: "david:command", command: value, trigger: "shortcut" }, null, resolve);
  }), name);
  const selectAnswer = async () => {
    assert.equal((await command("select-messages")).ok, true);
    await page.getByText("First response body with", { exact: false }).click();
  };
  try {
    assert.equal((await command("quick-copy")).count, 4);
    await selectAnswer();
    assert.equal((await command("select-messages")).action, "selection-mode-active");
    const copied = await command("quick-copy");
    assert.equal(copied.action, "copied-message-range"); assert.equal(copied.count, 1);
    const markdown = await page.evaluate(() => globalThis.__writes.at(-1));
    assert.match(markdown, /^## Assistant\n/u); assert.match(markdown, /First response body/u);
    assert.doesNotMatch(markdown, /First question|Second question|Second response/u);
    await selectAnswer();
    const downloaded = page.waitForEvent("download");
    assert.equal((await command("save-markdown")).action, "saved-message-range");
    assert.equal(fs.readFileSync(await (await downloaded).path(), "utf8"), markdown);
    assert.equal((await command("select-messages")).ok, true);
    for (const name of ["quick-copy", "save-markdown", "export-babel"]) {
      const result = await command(name); assert.equal(result.ok, false); assert.match(result.error, /Select at least one message/u);
    }
    assert.equal(await page.locator("#david-message-selector").count(), 1);
    await page.getByText("First response body with", { exact: false }).click();
    assert.equal((await command("export-babel")).action, "archive-started");
    assert.equal((await command("export-babel")).action, "ignored-busy");
    assert.equal((await command("quick-copy")).action, "ignored-busy");
    const captures = await page.evaluate(() => globalThis.__captures);
    assert.equal(captures.length, 1); assert.equal(captures[0].length, 1);
    assert.equal(captures[0][0].role, "assistant"); assert.match(captures[0][0].text, /First response body/u);
    assert.doesNotMatch(captures[0][0].text, /Second question|Second response/u);
    await page.evaluate(() => globalThis.__finishCapture());
    await page.waitForFunction(() => document.getElementById("david-copy-markdown-toast")?.textContent.includes("download started"));
    console.log("PASS native content actions reuse the selected message range and reject empty/repeated exports");

    await selectAnswer();
    const writeCount = await page.evaluate(() => globalThis.__writes.length);
    await page.evaluate(() => {
      const input = document.querySelector("textarea");
      const shadow = document.createElement("div");
      shadow.attachShadow({ mode: "open" }).innerHTML = '<div contenteditable="true">Draft</div>';
      document.body.append(shadow);
      const dispatch = (target, key, extra = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...extra }));
      for (const target of [input, shadow.shadowRoot.firstChild]) { dispatch(target, "Enter"); dispatch(target, "Escape"); }
      for (const key of ["Enter", "Escape"]) for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) dispatch(document.body, key, extra);
      const prevented = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      prevented.preventDefault(); document.body.dispatchEvent(prevented);
    });
    assert.equal(await page.locator("#david-message-selector").count(), 1);
    assert.equal(await page.evaluate(() => globalThis.__writes.length), writeCount);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("david-message-selector"));
    assert.equal(await page.evaluate(() => globalThis.__writes.length), writeCount + 1);
    await command("select-messages");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#david-message-selector").count(), 0);
    console.log("PASS range Enter/Escape remain available without hijacking editable or composing input");

    await page.evaluate(() => { globalThis.__blockClipboard = true; });
    const first = command("quick-copy");
    await page.waitForFunction(() => Boolean(globalThis.__releaseClipboard));
    assert.equal((await command("quick-copy")).action, "ignored-busy");
    await page.evaluate(() => { globalThis.__blockClipboard = false; globalThis.__releaseClipboard(); });
    assert.equal((await first).ok, true);
    assert.equal((await command("quick-copy")).ok, true);
    console.log("PASS content clipboard work is serialized and a later shortcut can run");
  } finally { await page.close(); }
}

async function testExtension(playwright, launch) {
  const context = await playwright.chromium.launchPersistentContext("", {
    ...launch, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    await context.route("**/*", (route) => /^(?:https?|wss?):/u.test(route.request().url()) ? route.abort() : route.continue());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const registered = (await worker.evaluate(() => chrome.commands.getAll())).filter((command) => commandNames.includes(command.name));
    assert.deepEqual(registered.map((command) => command.name).sort(), [...commandNames].sort());
    const actual = new Map(registered.map((command) => [command.name, command.shortcut]));
    assert.ok(registered.every((command) => typeof command.shortcut === "string"));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-command-shortcut]")].some((label) => label.textContent === "Loading…"));
    for (const name of commandNames) assert.equal(await page.locator(`[data-command-shortcut="${name}"]`).innerText(), actual.get(name) || "Unassigned");
    const popupHeight = await page.locator(".popup").evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(popupHeight <= 600, `popup controls should fit Chrome's 600px popup height (received ${popupHeight})`);
    if (process.env.DAVID_SHORTCUT_SCREENSHOT) await page.locator(".popup").screenshot({ path: process.env.DAVID_SHORTCUT_SCREENSHOT });
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), "0.6.0");
    const settingsPage = context.waitForEvent("page");
    await page.locator("#configure-shortcuts").click();
    await (await settingsPage).waitForURL("chrome://extensions/shortcuts");
    console.log(`PASS real unpacked MV3 registration and popup current binding display: ${registered.map((command) => `${command.name}=${command.shortcut || "Unassigned"}`).join(", ")}`);
    console.log("NOTE browser automation checks command registration and routed behavior; physical OS shortcut delivery is user/browser controlled.");
  } finally { await context.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
