"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { sourceForTests } = require('./helpers.cjs');
const runCases = require('./fixtures/archive-cards-cases.cjs');
async function main() {
  const playwright = require(process.env.DAVID_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await playwright.chromium.launch({headless:true,...(process.env.DAVID_CHROMIUM_PATH?{executablePath:process.env.DAVID_CHROMIUM_PATH}:{})});
  try {
    const page = await browser.newPage({viewport:{width:1000,height:760}});
    await page.setContent('<canvas width="320" height="240"></canvas>');
    const photo=Buffer.from(await page.evaluate(()=>{const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#278b56';x.fillRect(0,0,320,240);x.fillStyle='#ebaa44';x.fillRect(30,30,100,180);return c.toDataURL().split(',')[1];}),'base64');
    await page.route('**/*',route=>route.request().url().includes('/photo.png')?route.fulfill({contentType:'image/png',body:photo}):route.fulfill({contentType:'text/html',body:'<!doctype html><body>'}));
    await page.goto('https://chatgpt.com/c/archive-cards');
    await page.exposeFunction('__captureCardTab',async()=>`data:image/png;base64,${(await page.screenshot()).toString('base64')}`);
    await page.evaluate(()=>{globalThis.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(){return {ok:true,dataUrl:await globalThis.__captureCardTab()};}}};});
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'..','archive.js'),'utf8')});
    await page.addScriptTag({content:sourceForTests().replace('elementToMarkdown,','getChatGPTMessages, elementToMarkdown,')});
    for(const result of await page.evaluate(runCases,'https://media.example.invalid/photo.png'))console.log(result);
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
