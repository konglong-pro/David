"use strict";
// Shared by the headless regression runner and the local browser verification page.
module.exports = async function archiveCardCases(photoUrl) {
  const results = [];
  const check = (value, message) => { if (!value) throw new Error(message); };
  const markdown = element => globalThis.__davidTest.elementToMarkdown(element, { archiveAssets: true });
  const capture = root => globalThis.__davidArchiveV1.capture({ records: [{ root }], toMarkdown: markdown });
  const fixture = document.createElement('main'); document.body.appendChild(fixture);
  const nativeFetch = globalThis.fetch;
  const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
    if (image instanceof HTMLImageElement && image.src.startsWith(photoUrl)) throw new DOMException('Unreadable cross-origin pixels', 'SecurityError');
    return nativeDraw.call(this, image, ...args);
  };
  globalThis.fetch = (url, options) => String(url).startsWith(photoUrl) ? Promise.reject(new TypeError('Unreadable cross-origin image')) : nativeFetch(url, options);
  try {
    fixture.innerHTML = `<section id="cards"><div data-d-component="image" data-d-frame style="width:320px;height:90px;overflow:hidden"><img alt="Cropped first" style="display:block;width:320px;height:240px" src="${photoUrl}"></div><div data-d-component="image" data-d-frame style="width:320px;height:70px;overflow:hidden"><img alt="Cropped second" style="display:block;width:320px;height:240px" src="${photoUrl}"></div><p>After both cards</p></section>`;
    await Promise.all([...fixture.querySelectorAll('img')].map(i=>i.decode()));
    const cards = await capture(fixture.firstElementChild);
    const dimensions = [];
    for(const asset of cards.assets) { const image = new Image(); image.src=`data:${asset.mimeType};base64,${asset.dataBase64}`;await image.decode();dimensions.push([image.width,image.height]); }
    check(dimensions.some(([w,h])=>w===320&&h===90) && dimensions.some(([w,h])=>w===320&&h===70), 'Each cropped frame must retain its own visible dimensions: '+JSON.stringify(dimensions));
    check(cards.markdown.includes('After both cards') && cards.warnings.some(w=>w.includes('displayed cropped previews')), 'Cropped original-image warning and following text must survive');
    results.push('PASS inaccessible cropped image cards and distinct sizes for a repeated URL');

    fixture.innerHTML = '<section><div data-learning-block="true" style="width:400px;height:220px;background:#24354a;color:white"><div role="img" aria-label="Complete interactive periodic table">Hydrogen → Helium</div><button>Families</button><span style="display:block;width:0;height:0;overflow:hidden"><svg width="30" height="20"></svg></span></div><p>Following explanation</p></section>';
    const widget=await capture(fixture.firstElementChild);
    check(widget.assets.length===1 && widget.snapshot.tree.children[0].children[0].children[0].style.width==='400px','Learning block must be captured once before visiting internal controls');
    check(widget.markdown.includes('Complete interactive periodic table') && widget.markdown.includes('Following explanation') && widget.warnings.some(w=>w.includes('current control settings')), 'Whole widget and static-state warning must survive');
    const root=fixture.querySelector('[data-learning-block]'), text=root.firstElementChild.firstChild;
    const range=document.createRange();range.setStart(text,0);range.setEnd(text,4);
    let privacy='';try{await globalThis.__davidArchiveV1.capture({records:[{root}],ranges:[range],toMarkdown:markdown});}catch(e){privacy=e.message;}
    check(privacy.includes('unselected content'),'Partial widget selections must not capture surrounding content');
    results.push('PASS atomic interactive learning block, following text and partial-selection boundary');

    fixture.innerHTML = '<section style="height:50px;width:300px;overflow:hidden"><div style="width:300px;height:240px;background-image:linear-gradient(red,blue)">Clipped full diagram</div></section>';
    let clipping='';try{await capture(fixture.firstElementChild);}catch(e){clipping=e.message;}
    check(clipping.includes('clipped by its scrolling container'),'True clipped diagrams must remain explicit failures');
    results.push('PASS non-image clipping remains an explicit failure');

    globalThis.fetch=nativeFetch;
    const readable=new URL(photoUrl);readable.hostname=location.hostname;
    fixture.innerHTML=`<section><img alt="First" src="${readable.href}?one"><img alt="Second" src="${readable.href}?two"></section>`;
    await Promise.all([...fixture.querySelectorAll('img')].map(i=>i.decode()));
    const duplicate=await capture(fixture.firstElementChild);
    check(duplicate.assets.length===1 && (duplicate.markdown.match(/assets\/image-0001/g)||[]).length===2,'Identical raster bytes from different URLs must share one asset');
    results.push('PASS identical original-image bytes are stored only once');

    fixture.innerHTML=`<div data-message-author-role="user" data-message-id="user-1"><div data-user-message-bubble>Question</div></div><div data-chatgpt-search-message-ids="image-1"><div data-testid="generated-image-gallery"><button data-testid="generated-image-preview"><img alt="Generated picture" src="${readable.href}"></button><button>Ignore toolbar</button></div></div><div data-chatgpt-selection-message-id="text-1"><div data-markdown-text-style="assistant-message">Picture caption</div></div>`;
    const messages=globalThis.__davidTest.getChatGPTMessages().filter(m=>fixture.contains(m.root));
    check(messages.length===3 && messages.map(m=>m.role).join(',')==='user,assistant,assistant','Image-only assistant gallery must keep conversation order without duplicate user roots');
    check(messages[1].key==='message:image-1' && messages[2].key==='message:text-1','Generated picture and text must keep distinct stable message keys');
    const gallery=await capture(messages[1].root);
    check(gallery.assets.length===1 && gallery.markdown.includes('Generated picture') && !gallery.markdown.includes('Ignore toolbar'),'Generated preview button must retain its image and omit other buttons');
    fixture.style.backgroundColor='#101010';messages[0].root.style.backgroundColor='#502080';
    const conversation=await globalThis.__davidArchiveV1.capture({records:messages.map(m=>({root:m.root,role:m.role})),toMarkdown:markdown});
    check(conversation.snapshot.background==='rgb(16, 16, 16)','Conversation background must come from the shared surface, not the user bubble');
    results.push('PASS image-only generated gallery, stable keys, Markdown and archive image');
    return results;
  } finally { globalThis.fetch=nativeFetch;CanvasRenderingContext2D.prototype.drawImage=nativeDraw;fixture.remove(); }
};
