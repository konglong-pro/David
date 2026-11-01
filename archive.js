(() => {
  "use strict";
  if (globalThis.__davidArchiveV1) return;

  const LIMITS = Object.freeze({ markdown: 10 * 1024 * 1024, asset: 10 * 1024 * 1024,
    assets: 50, total: 100 * 1024 * 1024, wire: 150 * 1024 * 1024, nodes: 30_000, depth: 80 });
  const TAGS = new Set(("article section div span p h1 h2 h3 h4 h5 h6 pre code table thead tbody tfoot tr th td caption colgroup col figure figcaption img br hr ul ol li dl dt dd strong em b i u s del ins mark small sub sup a details summary header footer main aside nav blockquote time abbr kbd samp var q cite address hgroup ruby rb rt rp rtc").split(" "));
  const ATTRS = new Set(("id class title alt role aria-label aria-hidden aria-describedby aria-labelledby dir lang width height colspan rowspan scope start reversed type open datetime data-role data-language").split(" "));
  const STYLES = ("display visibility box-sizing position top right bottom left z-index width height min-width max-width min-height max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left overflow overflow-x overflow-y color background-color font-family font-size font-weight font-style line-height letter-spacing word-spacing text-align text-indent text-transform text-decoration-line text-decoration-color text-decoration-style white-space word-break overflow-wrap vertical-align border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius border-collapse border-spacing table-layout caption-side list-style-type list-style-position flex-direction flex-wrap flex-grow flex-shrink flex-basis order align-items align-content align-self justify-content justify-items justify-self gap row-gap column-gap grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column-start grid-column-end grid-row-start grid-row-end object-fit object-position opacity transform transform-origin box-shadow").split(" ");
  const MATH = ".katex-display,.katex,.math-inline,.math-block,math,mjx-container,[data-math],[data-tex],[data-latex],[data-math-source],[data-latex-source]";
  const OMIT = new Set(["script", "style", "link", "meta", "noscript", "template", "form", "input", "textarea", "select", "option", "button", "audio"]);
  let activeCapture = false;

  function failure(message) {
    return new Error(`${message} Select a smaller range or expand the visual and try again.`);
  }

  function assertArchiveLimits(archive) {
    const encoder = new TextEncoder();
    if (encoder.encode(archive.markdown).byteLength > LIMITS.markdown) throw failure("Markdown exceeds 10 MiB.");
    if (archive.assets.length > LIMITS.assets) throw failure("The archive exceeds 50 image assets.");
    let total = 0;
    for (const asset of archive.assets) {
      const bytes = asset.dataBase64.length / 4 * 3 - (asset.dataBase64.endsWith("==") ? 2 : asset.dataBase64.endsWith("=") ? 1 : 0);
      if (bytes > LIMITS.asset) throw failure("An image exceeds 10 MiB.");
      total += bytes;
    }
    if (total > LIMITS.total) throw failure("Decoded images exceed 100 MiB.");
    const assetUrls = new Map(archive.assets.map((asset) => [asset.id, `data:${asset.mimeType};base64,`.length + asset.dataBase64.length]));
    const escapedSize = (value) => encoder.encode(value).byteLength + (value.match(/&/g)?.length || 0) * 4 +
      (value.match(/"/g)?.length || 0) * 5 + (value.match(/'/g)?.length || 0) * 4 + (value.match(/[<>]/g)?.length || 0) * 3;
    const pending = [[archive.snapshot.tree, 1]];
    let count = 0;
    let renderedBytes = 2048 + escapedSize(archive.title);
    while (pending.length) {
      const [node, depth] = pending.pop();
      if (++count > LIMITS.nodes || depth > LIMITS.depth) throw failure("The snapshot exceeds 30,000 nodes or 80 levels.");
      if (typeof node === "string") renderedBytes += escapedSize(node);
      else {
        renderedBytes += node.tag.length * 2 + 5;
        for (const [key, value] of Object.entries(node.attrs || {})) {
          renderedBytes += key.length + 4 + (key === "src" ? assetUrls.get(value.slice("babel-asset://".length)) || 0 : escapedSize(value));
        }
        const declarations = Object.entries(node.style || {}).map(([key, value]) => `${key}:${value}`).join(";");
        if (declarations) renderedBytes += 9 + escapedSize(declarations);
        for (const child of node.children || []) pending.push([child, depth + 1]);
      }
      if (renderedBytes > LIMITS.wire) throw failure("The rendered snapshot exceeds 150 MiB, including repeated image references.");
    }
    if (archive.title.length > 1000) throw new Error("The page title exceeds 1,000 characters. Shorten it before exporting.");
    if (archive.snapshot.width > 100_000) throw failure("The snapshot layout is too wide.");
    const json = JSON.stringify(archive);
    if (encoder.encode(json).byteLength > LIMITS.wire) throw failure("The archive file exceeds 150 MiB.");
    return json;
  }

  function safeStyle(value) {
    return value && value.length <= 1000 && !/[\\;{}<>\u0000-\u001f\u007f]|\/\*|\*\/|url\s*\(|@|expression\s*\(|javascript\s*:/i.test(value);
  }

  function imageType(bytes) {
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value) && ascii(12, 16) === "IHDR") return ["image/png", "png"];
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ["image/jpeg", "jpg"];
    if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return ["image/gif", "gif"];
    if (bytes.length >= 16 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16))) return ["image/webp", "webp"];
    return null;
  }

  function toBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
    return btoa(binary);
  }

  function fromDataUrl(url) {
    const comma = url.indexOf(",");
    if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) throw new Error("The browser returned an unsupported raster image.");
    return Uint8Array.from(atob(url.slice(comma + 1)), (character) => character.charCodeAt(0));
  }

  function abortIfNeeded(signal) {
    if (signal.aborted) throw new DOMException("Export cancelled. No archive was downloaded.", "AbortError");
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() { signal.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Export cancelled. No archive was downloaded.", "AbortError")); }
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function readImageUrl(url, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 12_000);
    try {
      const response = await fetch(url, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("Image URL was not readable.");
      const length = Number(response.headers.get("content-length"));
      if (length > LIMITS.asset) throw failure("An image exceeds 10 MiB.");
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array(await response.arrayBuffer());
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          abortIfNeeded(signal);
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > LIMITS.asset) throw failure("An image exceeds 10 MiB.");
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }

  function canvasBytes(element) {
    const width = element.naturalWidth || element.videoWidth || element.width;
    const height = element.naturalHeight || element.videoHeight || element.height;
    if (!(width > 0 && height > 0) || width * height > 32_000_000) throw new Error("Image pixels are not readable at a safe size.");
    if (element.tagName === "CANVAS") return fromDataUrl(element.toDataURL("image/png"));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(element, 0, 0);
    return fromDataUrl(canvas.toDataURL("image/png"));
  }

  async function loadRaster(url, signal) {
    abortIfNeeded(signal);
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("The visual could not be rasterized.")), 8000);
      const abort = () => finish(new DOMException("Export cancelled.", "AbortError"));
      function finish(error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        image.onload = null; image.onerror = null;
        error ? reject(error) : resolve(image);
      }
      image.onload = () => finish();
      image.onerror = () => finish(new Error("The visual could not be rasterized."));
      signal.addEventListener("abort", abort, { once: true });
    });
    image.src = url;
    return loaded;
  }

  async function svgBytes(element, signal) {
    if (element.querySelector("foreignObject,image,animate,animateTransform,animateMotion,set") ||
      [...element.querySelectorAll("use")].some((node) => !/^#/.test(node.getAttribute("href") || node.getAttribute("xlink:href") || ""))) {
      throw new Error("This SVG needs a displayed-state screenshot to preserve its embedded visual content.");
    }
    if ([element, ...element.querySelectorAll("*")].some((node) => {
      const style = getComputedStyle(node);
      return [style.fill, style.stroke, style.filter, style.clipPath, style.maskImage].some((value) => /url\s*\(/i.test(value || "")) ||
        [style.transform, style.filter, style.backdropFilter, style.clipPath, style.maskImage].some((value) => value && value !== "none") ||
        (style.mixBlendMode && style.mixBlendMode !== "normal");
    })) throw new Error("This SVG uses referenced paint or effects and needs a displayed-state screenshot.");
    const clone = element.cloneNode(true);
    const originals = [element, ...element.querySelectorAll("*")];
    const copies = [clone, ...clone.querySelectorAll("*")];
    copies.forEach((copy, index) => {
      if (["script", "style", "iframe"].includes(copy.localName)) copy.remove();
      for (const attribute of [...copy.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === "style" || (/href$/i.test(attribute.name) && !attribute.value.startsWith("#"))) copy.removeAttribute(attribute.name);
      }
      const style = getComputedStyle(originals[index]);
      for (const property of ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity", "color", "font-family", "font-size", "font-style", "font-weight", "text-anchor", "dominant-baseline"]) {
        const value = style.getPropertyValue(property);
        if (value && !/url\s*\(/i.test(value)) copy.style.setProperty(property, value);
      }
    });
    const rect = element.getBoundingClientRect();
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(Math.ceil(rect.width)));
    clone.setAttribute("height", String(Math.ceil(rect.height)));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
    try { return canvasBytes(await loadRaster(url, signal)); }
    finally { URL.revokeObjectURL(url); }
  }

  function progressPanel(controller) {
    const host = document.createElement("div");
    host.id = "david-archive-progress";
    Object.assign(host.style, { position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647" });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<style>:host{all:initial}.panel{font:14px/1.45 system-ui,sans-serif;color:#0f172a;background:#fff;border:1px solid #94a3b8;border-radius:12px;padding:14px;max-width:360px;box-shadow:0 6px 24px #0003}button{margin-top:10px;padding:6px 12px;cursor:pointer}p{margin:4px 0}</style><section class="panel" role="status" aria-live="polite"><strong>Export for Babel</strong><p id="status">Preparing loaded messages…</p><p>Keep this tab active. Escape cancels.</p><button type="button">Cancel export</button></section>';
    shadow.querySelector("button").addEventListener("click", () => controller.abort());
    const escape = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
        event.composedPath().some((node) => node instanceof Element &&
          (node.matches('input, textarea, select, [role="textbox"], [role="combobox"]') || node.isContentEditable))) return;
      if (event.key === "Escape") { event.preventDefault(); controller.abort(); }
    };
    document.addEventListener("keydown", escape, true);
    (document.body || document.documentElement).appendChild(host);
    return { host, update(text) { shadow.getElementById("status").textContent = text; }, remove() { document.removeEventListener("keydown", escape, true); host.remove(); } };
  }

  async function screenshotBytes(element, state) {
    const { signal, panel } = state;
    abortIfNeeded(signal);
    const scrolls = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) scrolls.push([ancestor, ancestor.scrollLeft, ancestor.scrollTop]);
    const originalScroll = [window.scrollX, window.scrollY];
    const hidden = [];
    for (const node of document.querySelectorAll("*")) {
      if (node === panel.host) continue;
      if (node === element || element.contains(node) || node.contains(element)) continue;
      if (["fixed", "sticky"].includes(getComputedStyle(node).position)) {
        hidden.push([node, node.style.getPropertyValue("visibility"), node.style.getPropertyPriority("visibility")]);
        node.style.setProperty("visibility", "hidden", "important");
      }
    }
    try {
      element.scrollIntoView({ block: "start", inline: "start", behavior: "instant" });
      await wait(60, signal);
      const initial = element.getBoundingClientRect();
      const width = Math.ceil(initial.width), height = Math.ceil(initial.height);
      if (!(width > 0 && height > 0) || width * height > 32_000_000) throw failure("The displayed visual is too large to capture.");
      const clipping = scrolls.map(([node]) => {
        const css = getComputedStyle(node);
        return { node, x: /^(hidden|clip|auto|scroll|overlay)$/.test(css.overflowX), y: /^(hidden|clip|auto|scroll|overlay)$/.test(css.overflowY),
          scrollX: /^(auto|scroll|overlay)$/.test(css.overflowX), scrollY: /^(auto|scroll|overlay)$/.test(css.overflowY) };
      }).filter(({ node, x, y }) => node !== document.scrollingElement && (x || y));
      function visibleBounds() {
        const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        for (const { node, x, y } of clipping) {
          const rect = node.getBoundingClientRect();
          const left = rect.left + node.clientLeft, top = rect.top + node.clientTop;
          if (x) { bounds.left = Math.max(bounds.left, left); bounds.right = Math.min(bounds.right, left + node.clientWidth); }
          if (y) { bounds.top = Math.max(bounds.top, top); bounds.bottom = Math.min(bounds.bottom, top + node.clientHeight); }
        }
        return bounds;
      }
      const canvas = document.createElement("canvas");
      let scale = null;
      const stepX = Math.max(1, Math.min(window.innerWidth, ...clipping.filter((item) => item.x).map(({ node }) => node.clientWidth)) - 2);
      const stepY = Math.max(1, Math.min(window.innerHeight, ...clipping.filter((item) => item.y).map(({ node }) => node.clientHeight)) - 2);
      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          abortIfNeeded(signal);
          for (const { node, scrollX, scrollY } of clipping) {
            const rect = element.getBoundingClientRect(), port = node.getBoundingClientRect();
            node.scrollBy({ left: scrollX ? rect.left + x - port.left - node.clientLeft : 0,
              top: scrollY ? rect.top + y - port.top - node.clientTop : 0, behavior: "instant" });
          }
          const target = element.getBoundingClientRect();
          window.scrollBy({ left: target.left + x, top: target.top + y, behavior: "instant" });
          await wait(60, signal);
          let response;
          panel.host.style.visibility = "hidden";
          try { response = await chrome.runtime.sendMessage({ type: "david:capture-visible" }); }
          finally { panel.host.style.visibility = ""; }
          if (!response?.ok || typeof response.dataUrl !== "string") throw new Error(response?.error || "Chrome could not capture the active tab. Keep this tab active and try again.");
          const raster = await loadRaster(response.dataUrl, signal);
          const currentScale = raster.naturalWidth / window.innerWidth;
          if (scale === null) {
            scale = currentScale;
            if (width * height * scale * scale > 64_000_000) throw failure("The displayed visual is too large to capture at this display scale.");
            canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
          }
          if (Math.abs(scale - currentScale) > 0.01) throw new Error("Browser zoom changed during capture. Try the export again.");
          const rect = element.getBoundingClientRect();
          const bounds = visibleBounds();
          const left = Math.max(bounds.left, rect.left), top = Math.max(bounds.top, rect.top);
          const right = Math.min(bounds.right, rect.right), bottom = Math.min(bounds.bottom, rect.bottom);
          const targetRight = Math.min(width, x + stepX), targetBottom = Math.min(height, y + stepY);
          if (right <= left || bottom <= top || left - rect.left > x + 2 || top - rect.top > y + 2 || right - rect.left < targetRight - 2 || bottom - rect.top < targetBottom - 2) throw failure("A visual is clipped by its scrolling container and cannot be fully captured.");
          canvas.getContext("2d").drawImage(raster, left * scale, top * scale, (right - left) * scale, (bottom - top) * scale,
            (left - rect.left) * scale, (top - rect.top) * scale, (right - left) * scale, (bottom - top) * scale);
        }
      }
      state.warnings.add("Some displayed visuals were captured from the active tab as PNG. Their current appearance is preserved; interactions are not included.");
      state.screenshotElements.add(element);
      return fromDataUrl(canvas.toDataURL("image/png"));
    } finally {
      for (const [node, value, priority] of hidden) value ? node.style.setProperty("visibility", value, priority) : node.style.removeProperty("visibility");
      for (const [node, left, top] of scrolls) node.scrollTo({ left, top, behavior: "instant" });
      window.scrollTo({ left: originalScroll[0], top: originalScroll[1], behavior: "instant" });
      panel.host.style.visibility = "";
    }
  }

  function visible(element) {
    const css = getComputedStyle(element);
    return !element.hidden && css.display !== "none" && css.visibility !== "hidden" && css.visibility !== "collapse" && !element.classList.contains("sr-only");
  }

  function stylesFor(element) {
    const computed = getComputedStyle(element), output = {};
    for (const property of STYLES) {
      const value = computed.getPropertyValue(property).trim();
      if (safeStyle(value)) output[property] = value;
    }
    if (["fixed", "sticky"].includes(output.position)) {
      output.position = "relative";
      for (const edge of ["top", "right", "bottom", "left"]) delete output[edge];
    }
    return output;
  }

  function attrsFor(element, tag) {
    const output = {};
    for (const attribute of element.attributes) {
      if (ATTRS.has(attribute.name) && attribute.value.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(attribute.value)) output[attribute.name] = attribute.value;
    }
    if (tag === "a") {
      const href = element.getAttribute("href");
      if (href && /^#[^\s<>"'`]*$/.test(href)) output.href = href;
      else if (href && !output.title) output.title = element.href || href;
    }
    return output;
  }

  async function addAsset(bytes, state) {
    abortIfNeeded(state.signal);
    const type = imageType(bytes);
    if (!type) throw new Error("A captured image did not contain a supported raster format.");
    if (bytes.byteLength > LIMITS.asset) throw failure("An image exceeds 10 MiB.");
    const encoded = toBase64(bytes);
    if (state.assetByData.has(encoded)) return state.assetByData.get(encoded);
    if (state.assets.length >= LIMITS.assets) throw failure("The archive exceeds 50 image assets.");
    if (state.totalBytes + bytes.byteLength > LIMITS.total) throw failure("Decoded images exceed 100 MiB.");
    state.totalBytes += bytes.byteLength;
    const number = String(state.assets.length + 1).padStart(4, "0");
    const asset = { id: `asset-${number}`, name: `image-${number}.${type[1]}`, mimeType: type[0], dataBase64: encoded };
    state.assets.push(asset);
    state.assetByData.set(encoded, asset);
    state.panel.update(`Captured ${state.assets.length} image${state.assets.length === 1 ? "" : "s"}; preserving text and layout…`);
    await wait(60, state.signal);
    return asset;
  }

  async function visualAsset(element, kind, state) {
    if (state.assetByElement.has(element)) return state.assetByElement.get(element);
    let bytes;
    if (kind === "img") {
      const source = element.currentSrc || element.getAttribute("src") || "";
      let url;
      try { url = new URL(source, location.href); } catch { /* screenshot fallback below */ }
      if (url && ["http:", "https:", "blob:", "data:"].includes(url.protocol)) {
        if (state.assetByUrl.has(url.href)) return state.assetByUrl.get(url.href);
        try { bytes = await readImageUrl(url.href, state.signal); } catch (error) {
          abortIfNeeded(state.signal);
          if (/exceeds/.test(error.message)) throw error;
        }
        if (bytes && !imageType(bytes)) bytes = null;
      }
      if (!bytes) { try { bytes = canvasBytes(element); } catch { /* cross-origin rendered image */ } }
      if (!bytes) {
        if (!element.naturalWidth) state.warnings.add("A source image was not decoded when captured; its currently displayed placeholder is preserved. Load or expand it before exporting for the full image.");
        // Photo cards deliberately crop their preview. Preserve that displayed frame
        // when CORS prevents reading the original, rather than aborting the archive.
        let target = element;
        const frame = element.closest('[data-d-component="image"][data-d-frame]') || element.parentElement;
        if (frame) {
          const css = getComputedStyle(frame), box = frame.getBoundingClientRect(), image = element.getBoundingClientRect();
          if ((/^(hidden|clip)$/.test(css.overflowX) || /^(hidden|clip)$/.test(css.overflowY)) &&
            box.width > 0 && box.height > 0 && box.left >= image.left - 1 && box.top >= image.top - 1 &&
            box.right <= image.right + 1 && box.bottom <= image.bottom + 1 &&
            (box.width < image.width - 2 || box.height < image.height - 2)) target = frame;
        }
        bytes = await screenshotBytes(target, state);
        if (target !== element) {
          const box = target.getBoundingClientRect();
          state.screenshotDimensions.set(element, { width: box.width, height: box.height });
          state.screenshotElements.add(element);
          state.warnings.add("Some original images were not readable across origins. Their displayed cropped previews were preserved; the unavailable portions of the originals are not included.");
        }
      }
      const asset = await addAsset(bytes, state);
      state.assetByElement.set(element, asset);
      if (url && !state.screenshotElements.has(element)) state.assetByUrl.set(url.href, asset);
      return asset;
    }
    try {
      if (kind === "svg") bytes = await svgBytes(element, state.signal);
      else if (kind === "canvas" || kind === "video") bytes = canvasBytes(element);
    } catch { abortIfNeeded(state.signal); }
    if (!bytes) bytes = await screenshotBytes(element, state);
    const asset = await addAsset(bytes, state);
    state.assetByElement.set(element, asset);
    if (kind !== "math") state.warnings.add("SVG, canvas and embedded visuals are stored as static PNG images; their interactive behavior is not archived.");
    return asset;
  }

  function intersects(node, ranges) {
    return !ranges || ranges.some((range) => { try { return range.intersectsNode(node); } catch { return false; } });
  }

  function selectedText(node, ranges) {
    if (!ranges) return node.nodeValue || "";
    let output = "";
    for (const range of ranges) {
      if (!range.intersectsNode(node)) continue;
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.length;
      output += node.nodeValue.slice(start, end);
    }
    return output;
  }

  function fullySelected(node, ranges) {
    if (!ranges) return true;
    const whole = document.createRange();
    whole.selectNodeContents(node);
    return ranges.some((range) => range.compareBoundaryPoints(0, whole) <= 0 && range.compareBoundaryPoints(2, whole) >= 0);
  }

  function requireWholeVisual(node, ranges) {
    if (!fullySelected(node, ranges)) throw new Error("This partial selection contains a visual whose capture would include unselected content. Select the whole diagram, formula or message, or use Quick Copy for the selected text.");
  }

  async function walk(node, state, depth, ranges) {
    abortIfNeeded(state.signal);
    if (!intersects(node, ranges)) return null;
    if (++state.nodes > LIMITS.nodes || depth > LIMITS.depth) throw failure("The snapshot exceeds 30,000 nodes or 80 levels.");
    if (node.nodeType === Node.TEXT_NODE) {
      const text = selectedText(node, ranges);
      return text ? { tree: text, clone: document.createTextNode(text) } : null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || !visible(node)) return null;
    const tag = node.localName.toLowerCase() === "button" && node.matches('[data-testid="generated-image-preview"]')
      ? "div" : node.localName.toLowerCase();
    if (node.id?.startsWith("david-") || node.closest('#david-message-selector,#david-archive-progress,[data-markdown-copy="exclude"]')) return null;
    if (tag === "input" && node.type === "checkbox") {
      const clone = document.createElement("input");
      clone.type = "checkbox"; clone.checked = node.checked;
      return { tree: { tag: "span", attrs: { "aria-label": node.checked ? "Checked" : "Unchecked" }, children: [node.checked ? "☑ " : "☐ "] }, clone };
    }
    if (OMIT.has(tag)) {
      if (["form", "audio", "input", "textarea", "select"].includes(tag)) state.warnings.add("Form controls and audio players were omitted. Only displayed static content is archived.");
      return null;
    }
    if (node.matches('[data-learning-block="true"]')) {
      requireWholeVisual(node, ranges);
      const asset = await visualAsset(node, "layout", state);
      const rect = node.getBoundingClientRect();
      const alt = (node.querySelector('[role="img"]')?.getAttribute("aria-label") || "Interactive illustration").slice(0, 10_000);
      const clone = document.createElement("img");
      clone.setAttribute("data-david-archive-asset", asset.name); clone.alt = alt;
      state.warnings.add("Interactive learning blocks were preserved as complete static pictures, including their current control settings.");
      return { tree: { tag: "img", attrs: { src: `babel-asset://${asset.id}`, alt },
        style: { display: "block", width: `${rect.width}px`, height: `${rect.height}px`, "max-width": "100%" } }, clone };
    }
    const math = node.matches(MATH);
    const visual = ["img", "svg", "canvas", "video", "iframe", "object", "embed"].includes(tag);
    if (visual || math) {
      requireWholeVisual(node, ranges);
      const kind = math ? "math" : tag;
      const asset = await visualAsset(node, kind, state);
      const alt = (node.getAttribute("alt") || node.getAttribute("aria-label") || (math ? "Formula" : `${tag} visual`)).replace(/[\u0000-\u001f\u007f]/g, " ");
      if (alt.length > 10_000) throw failure("An image caption is too long for the archive.");
      const tree = { tag: "img", attrs: { src: `babel-asset://${asset.id}`, alt }, style: stylesFor(node) };
      const rect = node.getBoundingClientRect();
      if (state.screenshotElements.has(node)) {
        const size = state.screenshotDimensions.get(node) || rect;
        tree.style.width = `${size.width}px`; tree.style.height = `${size.height}px`;
        delete tree.style.transform; delete tree.style["transform-origin"];
      }
      let clone = math ? node.cloneNode(true) : document.createElement("img");
      if (math) {
        const probe = document.createElement("div"); probe.appendChild(clone);
        if (!/(^|[^\\])\\[([]/.test(state.toMarkdown(probe, null))) {
          clone = document.createElement("img");
          state.warnings.add("A displayed formula had no recoverable TeX or MathML source and was preserved as a PNG in both Markdown and the snapshot.");
        }
      }
      if (clone.tagName === "IMG") { clone.setAttribute("data-david-archive-asset", asset.name); clone.setAttribute("alt", alt); }
      return { tree, clone };
    }
    const safeTag = TAGS.has(tag) ? tag : "div";
    const tree = { tag: safeTag, attrs: attrsFor(node, safeTag), style: stylesFor(node), children: [] };
    if (node === state.recordRoot) {
      tree.style["margin-left"] = "0px";
      tree.style["margin-right"] = "0px";
    }
    const fontFamilies = getComputedStyle(node).fontFamily.split(",").map((family) => family.trim().replace(/^['"]|['"]$/g, "").toLowerCase());
    if (fontFamilies.some((family) => state.webFonts.has(family))) state.webFontRecords.add(state.recordRoot);
    const clone = document.createElement(TAGS.has(tag) ? tag : "div");
    for (const attribute of node.attributes) {
      if (!/^on/i.test(attribute.name) && attribute.name !== "src" && attribute.name !== "srcset") clone.setAttribute(attribute.name, attribute.value);
    }
    const summary = tag === "details" ? [...node.children].find((child) => child.localName === "summary") : null;
    for (const child of node.childNodes) {
      if (tag === "details" && !node.open && child !== summary) {
        if (child.nodeType === Node.ELEMENT_NODE || child.nodeValue?.trim()) state.warnings.add("Collapsed details were kept collapsed. Expand them before exporting to include their hidden content.");
        continue;
      }
      const captured = await walk(child, state, depth + 1, ranges);
      if (captured) { tree.children.push(captured.tree); clone.appendChild(captured.clone); }
    }
    const computed = getComputedStyle(node);
    const pseudo = ["::before", "::after"].some((selector) => {
      const content = getComputedStyle(node, selector).content;
      return content && !["none", "normal", '""', "''"].includes(content);
    });
    if (computed.backgroundImage !== "none" || computed.filter !== "none" || computed.maskImage !== "none" || computed.clipPath !== "none" || pseudo ||
      (node === state.recordRoot && state.webFontRecords.has(node))) {
      requireWholeVisual(node, ranges);
      const asset = await visualAsset(node, "layout", state);
      const rect = node.getBoundingClientRect();
      state.warnings.add("Some complex CSS layouts were flattened to static PNG so background imagery, web fonts, visual effects and generated labels retain their displayed appearance. Editable text remains in Markdown.");
      return { tree: { tag: "img", attrs: { src: `babel-asset://${asset.id}`, alt: node.getAttribute("aria-label") || "Original styled layout" },
        style: { display: "block", width: `${rect.width}px`, height: `${rect.height}px`, "max-width": "100%" } }, clone };
    }
    return { tree, clone };
  }

  function backgroundFor(element) {
    for (let node = element; node; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if (value && value !== "transparent" && value !== "rgba(0, 0, 0, 0)") return value;
    }
    return "#ffffff";
  }

  async function capture(options) {
    if (activeCapture) throw new Error("An archive export is already running. Cancel it before starting another.");
    activeCapture = true;
    const controller = options.controller || new AbortController();
    const panel = progressPanel(controller);
    const webFonts = new Set([...(document.fonts || [])].filter((font) => font.status === "loaded").map((font) => font.family.replace(/^['"]|['"]$/g, "").toLowerCase()));
    const state = { signal: controller.signal, panel, warnings: new Set(), assets: [], assetByElement: new Map(), assetByUrl: new Map(), assetByData: new Map(), totalBytes: 0, nodes: 0, webFonts, webFontRecords: new Set(), recordRoot: null,
      screenshotElements: new Set(), screenshotDimensions: new Map(), toMarkdown: options.toMarkdown };
    try {
      const root = { tag: "article", style: { "box-sizing": "border-box", "padding-top": "16px", "padding-right": "16px", "padding-bottom": "16px", "padding-left": "16px" }, children: [] };
      const markdown = [];
      let width = 0;
      if (options.text !== undefined) {
        root.children.push({ tag: "p", style: { "white-space": "pre-wrap" }, children: [options.text] });
        markdown.push(options.textMarkdown ?? options.text);
        width = 800;
      } else {
        for (const record of options.records) {
          abortIfNeeded(state.signal);
          const element = record.root;
          if (element.matches('[aria-busy="true"]') || element.querySelector('[aria-busy="true"]')) throw new Error("The selected response is still updating. Wait until generation finishes, then export again.");
          state.recordRoot = element;
          width = Math.max(width, element.getBoundingClientRect().width);
          const captured = await walk(element, state, 3, options.ranges || null);
          if (!captured) continue;
          const section = { tag: "section", attrs: {}, children: [] };
          if (record.role) {
            section.attrs["data-role"] = record.role;
            const label = record.role === "user" ? "User" : "Assistant";
            section.children.push({ tag: "h2", children: [label] });
            markdown.push(`## ${label}\n\n${options.toMarkdown(captured.clone, record.role)}`);
          } else markdown.push(options.toMarkdown(captured.clone, null));
          section.children.push(captured.tree);
          root.children.push(section);
        }
      }
      if (!root.children.length || !markdown.join("").trim()) throw new Error("No displayed content could be archived in this selection.");
      // Message bubbles carry their own background in the tree. Use their
      // shared surrounding surface for the archive, rather than tinting the
      // entire conversation with the first user's bubble color.
      let surface = options.records?.[0]?.root?.parentElement || document.body;
      for (const record of options.records || []) {
        while (surface.parentElement && !surface.contains(record.root)) surface = surface.parentElement;
      }
      const background = backgroundFor(surface);
      const sourceStyle = getComputedStyle(options.records?.[0]?.root || document.body);
      for (const [key, value] of [["color", sourceStyle.color], ["font-family", sourceStyle.fontFamily], ["line-height", sourceStyle.lineHeight]]) {
        if (safeStyle(value)) root.style[key] = value;
      }
      const sourceUrl = new URL(location.href);
      if (sourceUrl.username || sourceUrl.password) {
        sourceUrl.username = ""; sourceUrl.password = "";
        state.warnings.add("Credentials were removed from the recorded source URL.");
      }
      if (sourceUrl.href.length > 8192) throw new Error("The source URL exceeds the archive's 8,192 character limit.");
      const archive = { format: "babel.web-archive", version: 1, title: document.title || "Conversation", markdown: markdown.join("\n\n").trim(),
        source: { url: sourceUrl.href, title: document.title, capturedAt: new Date().toISOString() },
        assets: state.assets, snapshot: { tree: root, width: Math.max(320, Math.ceil(width + 32)), background }, warnings: [...state.warnings] };
      assertArchiveLimits(archive);
      abortIfNeeded(state.signal);
      return archive;
    } finally { panel.remove(); activeCapture = false; }
  }

  async function captureAndSave(options) {
    const archive = await capture(options);
    const json = assertArchiveLimits(archive);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(archive.title || "conversation").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[ .]+|[ .]+$/g, "").slice(0, 100) || "conversation"}.babel.json`;
    anchor.hidden = true;
    (document.body || document.documentElement).appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
    return { assets: archive.assets.length, warnings: archive.warnings.length };
  }

  globalThis.__davidArchiveV1 = Object.freeze({ captureAndSave, capture, assertArchiveLimits, imageType, safeStyle, limits: LIMITS });
})();
