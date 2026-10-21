"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const root = path.join(__dirname, "..");
const commands = ["quick-copy", "select-messages", "save-markdown", "export-babel"];

function background(overrides = {}) {
  const messages = [], injected = [], badges = [], titles = [], queries = [], listeners = {};
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const context = { URL, Error, console: { error() {} },
    chrome: {
      commands: { onCommand: { addListener(listener) { listeners.command = listener; } } },
      runtime: { getManifest: () => manifest, onMessage: { addListener(listener) { listeners.message = listener; } } },
      tabs: {
        async query(query) { queries.push(query); return [{ id: 18, url: "https://chatgpt.com/c/synthetic" }]; },
        async sendMessage(tabId, message) { messages.push({ tabId, message }); return overrides.response || { ok: true, action: message.command }; }
      },
      scripting: { async executeScript(options) { injected.push(options); if (overrides.inject) await overrides.inject(); } },
      action: { async setBadgeText(options) { badges.push(options); }, async setBadgeBackgroundColor() {}, async setTitle(options) { titles.push(options); } }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8") + "\nglobalThis.invokeNative = runShortcutCommand;", context);
  return { context, manifest, messages, injected, badges, titles, queries, listeners };
}

test("four native commands are browser scoped, configurable and preserve minimal permissions", () => {
  const manifest = background().manifest;
  assert.equal(manifest.version, "0.6.0");
  assert.deepEqual(Object.keys(manifest.commands), commands);
  assert.deepEqual(commands.map((name) => manifest.commands[name].suggested_key.default), ["Alt+Shift+Q", "Alt+Shift+S", "Alt+Shift+D", "Alt+Shift+E"]);
  for (const name of commands) {
    assert.equal(manifest.commands[name].global, undefined);
    assert.match(manifest.commands[name].suggested_key.mac, /^MacCtrl\+Shift\+[QSDE]$/u);
    assert.ok(manifest.commands[name].description.length > 0);
  }
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "clipboardWrite"]);
  assert.equal(manifest.host_permissions, undefined);
});

test("native actions use the invoking tab and the existing content command pipeline", async () => {
  const state = background();
  const tab = { id: 72, url: "https://chatgpt.com/c/synthetic" };
  for (const command of commands) {
    assert.equal((await state.context.invokeNative(command, tab)).ok, true);
  }
  assert.equal(state.queries.length, 0, "do not switch source tabs after invocation");
  assert.equal(state.injected.length, 4);
  assert.ok(state.injected.every((entry) => entry.target.tabId === 72 && entry.files.join(",") === "archive.js,content.js"));
  assert.deepEqual(state.messages.map((entry) => entry.message.command), commands);
  assert.ok(state.messages.every((entry) => entry.tabId === 72 && entry.message.trigger === "shortcut"));
  assert.ok(state.badges.every((badge) => badge.text === ""));
  assert.ok(state.titles.every((title) => title.title === state.manifest.action.default_title));
  const count = state.injected.length;
  state.listeners.command("unknown", tab);
  assert.equal(state.injected.length, count);
});

test("pending native actions reject repeats without releasing another invocation's lock", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = background({ inject: () => gate });
  const tab = { id: 18, url: "https://chatgpt.com/c/synthetic" };
  const first = state.context.invokeNative("quick-copy", tab);
  assert.equal((await state.context.invokeNative("quick-copy", tab)).action, "ignored-busy");
  assert.equal((await state.context.invokeNative("save-markdown", tab)).action, "ignored-busy");
  assert.equal(state.injected.length, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await state.context.invokeNative("save-markdown", tab)).ok, true);
  assert.equal(state.injected.length, 2);
});

test("native failures are visible on the source tab and clear after a successful retry", async () => {
  const state = background();
  const restricted = await state.context.invokeNative("quick-copy", { id: 3, url: "chrome://settings/" });
  assert.equal(restricted.ok, false); assert.match(restricted.error, /regular web page/u);
  assert.equal(state.injected.length, 0); assert.equal(state.badges.at(-1).text, "!");
  assert.equal(state.badges.at(-1).tabId, 3); assert.match(state.titles.at(-1).title, /regular web page/u);
  assert.equal((await state.context.invokeNative("quick-copy", { id: 3, url: "https://chatgpt.com/c/synthetic" })).ok, true);
  assert.equal(state.badges.at(-1).text, "");
  const denied = background({ response: { ok: false, error: "Select at least one message first." } });
  assert.equal((await denied.context.invokeNative("save-markdown")).ok, false);
  assert.match(denied.titles.at(-1).title, /Select at least one message first/u);
  assert.equal(denied.queries.length, 1, "onCommand's optional tab has an active-tab fallback");
});
