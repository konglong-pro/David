"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { sourceForTests } = require("./helpers.cjs");

async function main() {
  const playwright = require(process.env.DAVID_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.DAVID_CHROMIUM_PATH ? { executablePath: process.env.DAVID_CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 760 } });
    const page = await context.newPage();
    await page.setContent("<canvas width='320' height='180'></canvas>");
    const photo = Buffer.from(await page.evaluate(() => {
      const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d");
      const sky = ctx.createLinearGradient(0, 0, 0, 180); sky.addColorStop(0, "#2563eb"); sky.addColorStop(1, "#fde68a");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = "#334155";
      ctx.beginPath(); ctx.moveTo(0, 155); ctx.lineTo(90, 40); ctx.lineTo(170, 150); ctx.lineTo(245, 60); ctx.lineTo(320, 155); ctx.fill();
      ctx.fillStyle = "#166534"; ctx.fillRect(0, 155, 320, 25);
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "rich-conversation.html"), "utf8");
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/photo.png" || url.pathname === "/locked.png") return route.fulfill({ contentType: "image/png", body: photo });
      if (url.pathname === "/broken.png") return route.fulfill({ contentType: "image/png", body: "not a raster image" });
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/c/")) {
        const body = url.pathname.endsWith("legacy") ? fixture.replace('data-user-message-bubble="true"', 'class="whitespace-pre-wrap"').replace('data-markdown-text-style="assistant-message"', 'class="markdown"') : fixture;
        return route.fulfill({ contentType: "text/html; charset=utf-8", body });
      }
      return route.abort();
    });
    let screenshots = 0, lastScreenshot = 0;
    await page.exposeFunction("__captureSyntheticTab", async () => {
      const delay = 550 - (Date.now() - lastScreenshot);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      lastScreenshot = Date.now(); screenshots++;
      return `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}`;
    });
    await page.addInitScript(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => String(url).includes("media.example.invalid/locked.png")
        ? Promise.reject(new TypeError("Synthetic source image forbids readable cross-origin fetch."))
        : nativeFetch(url, options);
      globalThis.chrome = { runtime: {
        onMessage: { addListener(listener) { globalThis.__davidCommandListener = listener; } },
        async sendMessage(message) {
          if (message.type === "david:capture-visible") return { ok: true, dataUrl: await globalThis.__captureSyntheticTab() };
          throw new Error("Unexpected synthetic extension message.");
        }
      } };
      Object.defineProperty(navigator, "clipboard", { value: { async writeText(text) { globalThis.__copiedMarkdown = text; } } });
    });
    async function open(variant) {
      await page.goto(`https://chatgpt.com/c/${variant}`);
      await page.evaluate(async () => {
        await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
        const canvas = document.getElementById("plot"), ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff7ed"; ctx.fillRect(0, 0, 400, 160); ctx.strokeStyle = "#ea580c"; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(15, 140); ctx.quadraticCurveTo(150, 10, 385, 100); ctx.stroke();
      });
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, "..", "archive.js"), "utf8") });
      await page.addScriptTag({ content: sourceForTests() });
    }
    const command = (name) => page.evaluate((commandName) => new Promise((resolve) => globalThis.__davidCommandListener({ type: "david:command", command: commandName }, null, resolve)), name);
    async function exported(trigger) {
      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      await trigger();
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(), /\.babel\.json$/u);
      return JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    }
    function inspect(archive) {
      assert.equal(archive.format, "babel.web-archive"); assert.equal(archive.version, 1);
      const json = JSON.stringify(archive.snapshot);
      assert.doesNotMatch(json, /EXCLUDED DECORATIVE DUPLICATE|Copy toolbar control|"tag":"(?:svg|canvas|script|iframe|form|input)"/u);
      assert.doesNotMatch(json, /"src":"https?:|url\(/u);
      assert.ok(archive.assets.some((asset) => asset.dataBase64 === photo.toString("base64")), "original readable photo bytes survive");
      assert.ok(archive.assets.length >= 7, "photo, SVG, canvas, inaccessible image, embedded SVG, CSS layout and formula all survive");
      assert.ok(archive.assets.every((asset) => asset.mimeType === "image/png" && Buffer.from(asset.dataBase64, "base64").subarray(1, 4).toString() === "PNG"));
      assert.match(archive.markdown, /SVG caption: a sine wave/u);
      assert.match(archive.markdown, /Canvas caption: orange curve/u);
      assert.match(archive.markdown, /!\[Sine wave diagram\]\(assets\/image-\d+\.png\)/u);
      assert.match(archive.markdown, /!\[Canvas diagram\]\(assets\/image-\d+\.png\)/u);
      assert.ok(archive.markdown.includes(String.raw`\(x_1 + \frac{a}{b}\)`));
      assert.match(archive.markdown, /```python\nx = 1\nprint\(x\)\n```/u);
      assert.match(archive.markdown, /- \[x\] Completed observation\n- \[ \] Pending observation/u);
      assert.match(archive.markdown, /First<br>Second/u);
      assert.ok(archive.warnings.some((warning) => /active tab/.test(warning)));
      assert.ok(archive.warnings.some((warning) => /complex CSS/.test(warning)));
    }
    await open("modern");
    await page.evaluate(() => window.scrollTo(0, 100));
    const before = await page.evaluate(() => [scrollX, scrollY]);
    const modern = await exported(async () => assert.equal((await command("export-babel")).action, "archive-started"));
    inspect(modern);
    assert.ok(screenshots >= 4, "unreadable image, embedded SVG, CSS background and formula use screenshot fallback");
    assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), before, "capture restores source scrolling");
    assert.equal(await page.locator("#david-archive-progress").count(), 0);
    if (process.env.DAVID_BABEL_CORE) {
      const core = await import(pathToFileURL(process.env.DAVID_BABEL_CORE).href);
      core.validateWebArchive(modern);
      const html = core.renderWebArchiveSnapshot(modern);
      assert.doesNotMatch(html, /<script|<svg|<canvas|<iframe|src="https?:/u);
      console.log("PASS actual Babel core validation and offline renderer");
    }
    if (process.env.DAVID_ARCHIVE_FIXTURE_OUTPUT) {
      fs.writeFileSync(process.env.DAVID_ARCHIVE_FIXTURE_OUTPUT, JSON.stringify(modern, null, 2));
      console.log(`Captured rich fixture: ${process.env.DAVID_ARCHIVE_FIXTURE_OUTPUT}`);
    }
    console.log(`PASS modern rich export: ${modern.assets.length} portable images, layout, captions, formula, table, code and screenshot fallback`);

    const selection = await exported(async () => {
      await page.evaluate(() => { const range = document.createRange(); range.selectNode(document.getElementById("wave-figure")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
      await command("export-babel");
    });
    assert.equal(selection.assets.length, 1); assert.doesNotMatch(selection.markdown, /^## (User|Assistant)/u);
    assert.match(selection.markdown, /SVG caption/u); assert.doesNotMatch(selection.markdown, /Canvas caption/u);
    console.log("PASS selected rendered visual and caption archive");

    await page.evaluate(() => getSelection().removeAllRanges());
    await command("select-messages");
    await page.locator('[data-message-author-role="user"] p').click();
    const ranged = await exported(() => page.locator("#david-message-selector #archive").click());
    assert.match(ranged.markdown, /^## User/u); assert.doesNotMatch(ranged.markdown, /## Assistant/u); assert.equal(ranged.assets.length, 1);
    console.log("PASS selected message range archive");

    const countBeforeCancel = screenshots;
    await command("export-babel");
    await page.evaluate(() => {
      const input = document.createElement("textarea"); document.body.appendChild(input);
      const shadow = document.createElement("div");
      shadow.attachShadow({ mode: "open" }).innerHTML = '<div contenteditable="true">Draft</div>';
      document.body.appendChild(shadow);
      const escape = (target, extra = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true, ...extra }));
      escape(input); escape(shadow.shadowRoot.firstChild);
      for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) escape(document.body, extra);
      input.remove(); shadow.remove();
    });
    assert.equal(await page.locator("#david-archive-progress").count(), 1, "editing/composition Escape must not cancel an archive");
    await page.locator("#david-archive-progress button").click();
    await page.waitForFunction(() => !document.getElementById("david-archive-progress"));
    assert.match(await page.locator("#david-copy-markdown-toast").textContent(), /cancelled/i);
    console.log(`PASS visible progress cancellation and editable/IME Escape guards (${screenshots - countBeforeCancel} screenshot requests before cancel)`);

    await open("legacy");
    const legacy = await exported(() => command("export-babel"));
    inspect(legacy); assert.match(legacy.markdown, /^## User/u); assert.match(legacy.markdown, /## Assistant/u);
    console.log("PASS legacy ChatGPT rich archive");

    await page.evaluate(async () => {
      const figure = document.createElement("figure"); figure.id = "tall-fallback";
      const image = document.createElement("img"); image.src = "https://media.example.invalid/locked.png"; image.alt = "Tall screenshot fallback";
      image.style.width = "250px"; image.style.height = "1200px"; image.style.maxWidth = "none";
      figure.appendChild(image); document.body.appendChild(figure); await image.decode();
      const range = document.createRange(); range.selectNode(figure); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.scrollTo(0, 50);
    });
    const tiledBefore = screenshots;
    const tiled = await exported(() => command("export-babel"));
    assert.equal(tiled.assets.length, 1);
    const pixels = Buffer.from(tiled.assets[0].dataBase64, "base64");
    assert.equal(pixels.readUInt32BE(16), 250); assert.equal(pixels.readUInt32BE(20), 1200);
    assert.ok(screenshots - tiledBefore >= 2);
    assert.equal(await page.evaluate(() => scrollY), 50);
    console.log("PASS multi-viewport screenshot stitching, exact dimensions and scroll restoration");

    const streamingError = await page.evaluate(async () => {
      const root = document.createElement("section"); root.setAttribute("aria-busy", "true"); root.textContent = "Synthetic response still streaming"; document.body.appendChild(root);
      try { await globalThis.__davidArchiveV1.capture({ records: [{ root, role: "assistant" }], toMarkdown: (element) => element.textContent }); return null; }
      catch (error) { return error.message; } finally { root.remove(); }
    });
    assert.match(streamingError, /still updating/u);
    const clippedError = await page.evaluate(async () => {
      const root = document.createElement("section"); root.style.cssText = "height:80px;overflow:hidden;width:250px";
      const image = document.createElement("div"); image.style.cssText = "width:250px;height:500px;background-image:linear-gradient(red,blue)"; root.appendChild(image); document.body.appendChild(root);
      try { await globalThis.__davidArchiveV1.capture({ records: [{ root }], toMarkdown: (element) => globalThis.__davidTest.elementToMarkdown(element, { archiveAssets: true }) }); return null; }
      catch (error) { return error.message; } finally { root.remove(); }
    });
    assert.match(clippedError, /clipped by its scrolling container/u);
    const broken = await page.evaluate(async () => {
      const root = document.createElement("section"), image = document.createElement("img"); image.src = "/broken.png"; image.alt = "Broken image placeholder"; image.style.cssText = "width:180px;height:60px";
      root.appendChild(image); document.body.appendChild(root); await image.decode().catch(() => undefined);
      try { return await globalThis.__davidArchiveV1.capture({ records: [{ root }], toMarkdown: (element) => globalThis.__davidTest.elementToMarkdown(element, { archiveAssets: true }) }); }
      finally { root.remove(); }
    });
    assert.equal(broken.assets.length, 1); assert.ok(broken.warnings.some((warning) => /not decoded/.test(warning)));
    console.log("PASS streaming, clipped visual and broken image handling is explicit");

    const privacy = await page.evaluate(async () => {
      const failures = [];
      for (const html of [
        '<p style="background-image:linear-gradient(red,blue)">KEEP SECRET</p>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><text y="25">KEEP SECRET</text></svg>',
        '<span class="katex" data-math="KEEP + SECRET">KEEP SECRET</span>'
      ]) {
        const holder = document.createElement("section"); holder.innerHTML = html; document.body.appendChild(holder);
        const root = holder.firstElementChild;
        const text = root.localName === "svg" ? root.firstElementChild.firstChild : root.firstChild;
        const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
        try { await globalThis.__davidArchiveV1.capture({ records: [{ root }], ranges: [range], toMarkdown: (element) => globalThis.__davidTest.elementToMarkdown(element, { archiveAssets: true }) }); failures.push(null); }
        catch (error) { failures.push(error.message); } finally { holder.remove(); }
      }
      return failures;
    });
    assert.equal(privacy.length, 3); assert.ok(privacy.every((message) => /unselected content/.test(message)));
    console.log("PASS partial CSS, SVG and formula selections cannot capture unselected content");

    const fallbacks = await page.evaluate(async () => {
      const root = document.createElement("section");
      root.innerHTML = '<p>Rendered-only formula:</p><mjx-container><svg xmlns="http://www.w3.org/2000/svg" width="180" height="45"><text y="30">x + y = z</text></svg></mjx-container><details><summary>Reasoning</summary>HIDDEN DIRECT TEXT<p>HIDDEN PARAGRAPH</p></details><svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="40" height="40" style="fill:orange;transform:translate(60px,0);filter:blur(1px)"/></svg>';
      document.body.appendChild(root);
      try { return await globalThis.__davidArchiveV1.capture({ records: [{ root }], toMarkdown: (element) => globalThis.__davidTest.elementToMarkdown(element, { archiveAssets: true }) }); }
      finally { root.remove(); }
    });
    assert.match(fallbacks.markdown, /!\[Formula\]\(assets\/image-\d+\.png\)/u);
    assert.doesNotMatch(fallbacks.markdown, /HIDDEN DIRECT TEXT|HIDDEN PARAGRAPH/u);
    assert.doesNotMatch(JSON.stringify(fallbacks.snapshot), /HIDDEN DIRECT TEXT|HIDDEN PARAGRAPH/u);
    assert.ok(fallbacks.warnings.some((warning) => /no recoverable TeX/.test(warning)));
    assert.ok(fallbacks.warnings.some((warning) => /Collapsed details/.test(warning)));
    assert.ok(fallbacks.warnings.some((warning) => /active tab/.test(warning)));
    assert.equal(fallbacks.assets.length, 2);
    console.log("PASS source-less formula PNG, collapsed detail privacy and SVG CSS effects fallback");
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
