"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function archiveApi() {
  const context = { TextEncoder, Uint8Array, btoa, atob };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "archive.js"), "utf8"), context);
  return context.__davidArchiveV1;
}
const api = archiveApi();
const minimal = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "minimal.babel.json"), "utf8"));

test("raster sniffing matches the archive signatures, not filename or declared MIME", () => {
  const png = Buffer.from(minimal().assets[0].dataBase64, "base64");
  assert.equal(api.imageType(png)[0], "image/png");
  assert.equal(api.imageType(png.subarray(0, 8)), null);
  assert.equal(api.imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(api.imageType(Buffer.from("GIF89a")), null);
  assert.equal(api.imageType(Buffer.from("RIFF0000WEBP????")), null);
  assert.equal(api.imageType(Uint8Array.from([255, 216, 255, 224]))[0], "image/jpeg");
});

test("snapshot style values reject resource loads, scripts and CSS injection", () => {
  for (const style of ["url(https://example.invalid/pixel)", "URL (#x)", "red;display:none", "expression(alert(1))", "@font-face", "javascript:alert", "a\\62", "red/*comment*/", "<style>", "x\ncolor:red"]) {
    assert.equal(Boolean(api.safeStyle(style)), false, style);
  }
  for (const style of ["rgb(20, 30, 40)", "1fr 2fr", "matrix(1, 0, 0, 1, 0, 0)", '"Arial", sans-serif', "10px"]) assert.equal(Boolean(api.safeStyle(style)), true);
});

test("archive bounds reject excessive Markdown, images and tree complexity without truncation", () => {
  assert.equal(JSON.parse(api.assertArchiveLimits(minimal())).format, "babel.web-archive");
  const markdown = minimal(); markdown.markdown = "汉".repeat(3_500_000);
  assert.throws(() => api.assertArchiveLimits(markdown), /10 MiB/);
  const count = minimal(); count.assets = Array(51).fill(count.assets[0]);
  assert.throws(() => api.assertArchiveLimits(count), /50 image/);
  const bytes = minimal(); bytes.assets[0].dataBase64 = "AAAA".repeat(3_500_000);
  assert.throws(() => api.assertArchiveLimits(bytes), /10 MiB/);
  const nodes = minimal(); nodes.snapshot.tree.children = Array(30_000).fill("x");
  assert.throws(() => api.assertArchiveLimits(nodes), /30,000/);
  const depth = minimal(); let tree = depth.snapshot.tree;
  for (let index = 0; index < 80; index++) { tree.children = [{ tag: "div" }]; tree = tree.children[0]; }
  assert.throws(() => api.assertArchiveLimits(depth), /80 levels/);
});

test("repeated asset references cannot inflate the rendered snapshot beyond 150 MiB", () => {
  const archive = minimal();
  archive.assets[0].dataBase64 = "AAAA".repeat(3_000_000);
  archive.snapshot.tree.children = Array.from({ length: 14 }, () => ({ tag: "img", attrs: { src: "babel-asset://asset-0001" } }));
  assert.throws(() => api.assertArchiveLimits(archive), /rendered snapshot exceeds 150 MiB/);
});

test("screenshot helper validates sender/tab and serializes below Chrome's two per second cap", async () => {
  let now = 10_000;
  const captured = [], waits = [], listeners = [];
  let active = 7;
  const context = { URL, Date: { now: () => now }, setTimeout(fn, ms) { waits.push(ms); now += ms; fn(); },
    chrome: { commands: { onCommand: { addListener() {} } }, runtime: { id: "david-test", onMessage: { addListener(listener) { listeners.push(listener); } } },
      tabs: { async query() { return [{ id: active }]; }, async captureVisibleTab(windowId) { captured.push([windowId, now]); return "data:image/png;base64,test"; } } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8") + "\nglobalThis.capture = captureSenderTab;", context);
  const sender = { id: "david-test", tab: { id: 7, windowId: 2, url: "https://chatgpt.com/c/synthetic" } };
  await Promise.all([context.capture(sender), context.capture(sender), context.capture(sender)]);
  assert.equal(captured.length, 3); assert.ok(captured[1][1] - captured[0][1] >= 550); assert.ok(captured[2][1] - captured[1][1] >= 550);
  await assert.rejects(context.capture({ ...sender, id: "other-extension" }), /Only a David capture/);
  active = 8;
  await assert.rejects(context.capture(sender), /no longer active/);
  assert.equal(captured.length, 3); assert.ok(waits.every((ms) => ms >= 0)); assert.equal(listeners.length, 1);
});
