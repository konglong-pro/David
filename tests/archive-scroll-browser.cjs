"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const playwright = require(process.env.DAVID_PLAYWRIGHT_MODULE || "playwright");
  const source = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "archive.js"), "utf8");
  const browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.DAVID_CHROMIUM_PATH ? { executablePath: process.env.DAVID_CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    let screenshots = 0;
    await page.exposeFunction("__captureSyntheticTab", async () => {
      screenshots++;
      return `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}`;
    });
    for (const kind of ["nested", "window", "hidden", "cancel"]) {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;${kind === "window" ? "" : "height:100%;overflow:hidden"}}
        .shell{${kind === "window" ? "" : "height:100%;overflow:hidden"}}
        #outer{${kind === "window" ? "" : "width:620px;height:390px;overflow:auto;border:9px solid #222;margin:15px;padding-top:70px;padding-bottom:70px;scroll-behavior:smooth"}}
        #inner{${kind === "window" ? "" : `width:420px;height:260px;overflow:${kind === "hidden" ? "hidden" : "auto"};border:7px solid #444;scroll-behavior:smooth`}}
        #visual{width:${kind === "window" ? 500 : 650}px;height:850px;background-image:linear-gradient(to bottom,transparent 50%,rgba(0,0,255,.5) 50%),linear-gradient(to right,red 50%,lime 50%)}
        #composer{position:fixed;inset:auto 0 0;height:90px;background:black}
      </style><div class="shell"><div id="outer"><div id="inner"><div id="visual" aria-label="Test diagram"></div></div></div></div><div id="composer">Fixed composer must not enter capture</div>`);
      await page.evaluate(() => {
        globalThis.chrome = { runtime: { async sendMessage() {
          const dataUrl = await globalThis.__captureSyntheticTab();
          if (globalThis.__cancelCapture) globalThis.__captureController.abort();
          return { ok: true, dataUrl };
        } } };
        document.getElementById("outer").scrollTo({ left: 0, top: 35, behavior: "instant" });
        document.getElementById("inner").scrollTo({ left: 25, top: 45, behavior: "instant" });
        window.scrollTo({ top: 50, behavior: "instant" });
      });
      await page.addScriptTag({ content: source });
      const before = await page.evaluate(() => [scrollX, scrollY, ...["outer", "inner"].flatMap(id => {
        const node = document.getElementById(id); return [node.scrollLeft, node.scrollTop];
      })]);
      const countBefore = screenshots;
      const result = await page.evaluate(async kind => {
        globalThis.__captureController = new AbortController();
        globalThis.__cancelCapture = kind === "cancel";
        try {
          const archive = await globalThis.__davidArchiveV1.capture({ records: [{ root: document.getElementById("visual") }],
            controller: globalThis.__captureController, toMarkdown: () => "Synthetic diagram" });
          const image = new Image(); image.src = `data:image/png;base64,${archive.assets[0].dataBase64}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
          const pixels = [[20,20],[image.width-20,20],[20,image.height-20],[image.width-20,image.height-20]]
            .map(([x,y]) => [...ctx.getImageData(x,y,1,1).data]);
          return { width: image.width, height: image.height, assets: archive.assets.length, pixels };
        } catch (error) { return { error: error.message }; }
      }, kind);
      if (kind === "nested" || kind === "window") assert.equal(result.error, undefined, `${kind}: ${result.error}`);
      assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, ...["outer", "inner"].flatMap(id => {
        const node = document.getElementById(id); return [node.scrollLeft, node.scrollTop];
      })]), before, `${kind}: all scroll positions restored`);
      assert.equal(await page.locator("#composer").evaluate(node => node.style.visibility), "");
      assert.equal(await page.locator("#david-archive-progress").count(), 0);
      if (kind === "hidden") assert.match(result.error, /clipped by its scrolling container/);
      else if (kind === "cancel") assert.match(result.error, /cancelled/i);
      else {
        assert.equal(result.error, undefined, `${kind}: ${result.error}`);
        assert.equal(result.width, kind === "window" ? 500 : 650); assert.equal(result.height, 850); assert.equal(result.assets, 1);
        const expected = [[255,0,0,255],[0,255,0,255],[127,0,128,255],[0,127,128,255]];
        assert.ok(result.pixels.every((pixel, index) => pixel.every((channel, component) => Math.abs(channel - expected[index][component]) <= 1)), `${kind}: complete raster corners, no clipped pixels or composer: ${JSON.stringify(result.pixels)}`);
        assert.ok(screenshots - countBefore >= 2, `${kind}: screenshot was stitched`);
      }
      console.log(`PASS ${kind}: ${screenshots - countBefore} screenshots; exact pixels, clipping/cancellation and scroll restoration`);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
