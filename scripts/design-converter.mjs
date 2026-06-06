#!/usr/bin/env node
/**
 * design-converter.mjs — 纯转换模块：蓝湖 DDS Schema / Sketch JSON → HTML+CSS。
 * 无 HTTP 依赖，无副作用。对应 lanhu-mcp lanhu_mcp_server.py L157–L1731。
 */

// ── 常量 ─────────────────────────────────────────────────────────────────────

const UNITLESS_PROPERTIES = new Set([
  "zIndex","fontWeight","opacity","flex","flexGrow","flexShrink","order",
]);

const COMMON_CSS_FOR_DESIGN = `
body * {
  box-sizing: border-box;
  flex-shrink: 0;
}
body {
  font-family: PingFangSC-Regular, Roboto, Helvetica Neue, Helvetica, Tahoma,
    Arial, PingFang SC-Light, Microsoft YaHei;
}
input {
  background-color: transparent;
  border: 0;
}
button {
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  outline: none;
  background-color: transparent;
}
button:active {
  opacity: 0.6;
}
.flex-col { display: flex; flex-direction: column; }
.flex-row { display: flex; flex-direction: row; }
.justify-start { display: flex; justify-content: flex-start; }
.justify-center { display: flex; justify-content: center; }
.justify-end { display: flex; justify-content: flex-end; }
.justify-evenly { display: flex; justify-content: space-evenly; }
.justify-around { display: flex; justify-content: space-around; }
.justify-between { display: flex; justify-content: space-between; }
.align-start { display: flex; align-items: flex-start; }
.align-center { display: flex; align-items: center; }
.align-end { display: flex; align-items: flex-end; }
`;

// ── CSS 辅助 ─────────────────────────────────────────────────────────────────

function camelToKebab(s) {
  return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

function formatCssValue(key, value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (value === 0) return "0";
    return UNITLESS_PROPERTIES.has(key) ? String(value) : `${value}px`;
  }
  if (typeof value === "string") {
    if (value.includes("rgba(")) {
      return value.replace(
        /rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g,
        (_, r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${a.includes(".") ? parseFloat(a) : parseInt(a, 10)})`
      );
    }
    if (/^\d+$/.test(value) && !UNITLESS_PROPERTIES.has(key)) {
      return value === "0" ? "0" : `${value}px`;
    }
  }
  return String(value);
}

function mergeSides(styles, t, r, b, l, shorthand) {
  if (!(t in styles && r in styles && b in styles && l in styles)) return;
  const [tv, rv, bv, lv] = [styles[t]||0, styles[r]||0, styles[b]||0, styles[l]||0];
  styles[shorthand] = (tv===bv && lv===rv)
    ? (tv===lv ? `${tv}px` : `${tv}px ${rv}px`)
    : `${tv}px ${rv}px ${bv}px ${lv}px`;
  for (const k of [t, r, b, l]) delete styles[k];
}

function mergePadding(s) {
  mergeSides(s, "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "padding");
}
function mergeMargin(s) {
  mergeSides(s, "marginTop", "marginRight", "marginBottom", "marginLeft", "margin");
}

// ── Flex 分析 ─────────────────────────────────────────────────────────────────

function shouldUseFlex(node) {
  if (!node) return false;
  const style = { ...(node.style||{}), ...((node.props||{}).style||{}) };
  return style.display === "flex" || style.flexDirection !== undefined;
}

function getFlexClasses(node) {
  const classes = [];
  if (!shouldUseFlex(node)) return classes;
  const style = { ...(node.style||{}), ...((node.props||{}).style||{}) };
  const className = (node.props||{}).className || "";
  const aj = node.alignJustify || {};
  const dir = style.flexDirection;
  if (dir === "column" || className.includes("flex-col")) classes.push("flex-col");
  else if (dir === "row" || className.includes("flex-row")) classes.push("flex-row");
  const jmap = { "space-between":"justify-between","center":"justify-center","flex-end":"justify-end","flex-start":"justify-start","space-around":"justify-around","space-evenly":"justify-evenly" };
  const justify = aj.justifyContent || style.justifyContent;
  if (jmap[justify]) classes.push(jmap[justify]);
  const amap = { "flex-start":"align-start","center":"align-center","flex-end":"align-end" };
  const align = aj.alignItems || style.alignItems;
  if (amap[align]) classes.push(amap[align]);
  return classes;
}

function cleanStyles(node, flexClasses) {
  const propsStyle = (node.props||{}).style || {};
  const result = {};
  const stdJ = new Set(["flex-start","center","flex-end","space-between","space-around","space-evenly"]);
  const stdA = new Set(["flex-start","center","flex-end"]);
  for (const [key, value] of Object.entries(propsStyle)) {
    if ((key==="display"||key==="flexDirection") && flexClasses.length) continue;
    if (key==="justifyContent" && flexClasses.length && stdJ.has(value)) continue;
    if (key==="alignItems" && flexClasses.length && stdA.has(value)) continue;
    if (key==="position" && value==="static") continue;
    if (key==="overflow" && value==="visible") continue;
    result[key] = value;
  }
  if (["paddingTop","paddingRight","paddingBottom","paddingLeft"].some(k=>k in result)) mergePadding(result);
  if (["marginTop","marginRight","marginBottom","marginLeft"].some(k=>k in result)) mergeMargin(result);
  return result;
}

// ── 循环 & 递归生成器 ─────────────────────────────────────────────────────────

function getLoopArr(node) {
  const arr = node.loop || node.loopData;
  return Array.isArray(arr) ? arr : [];
}

function resolveLoopPlaceholder(value, loopItem) {
  if (!value || typeof loopItem !== "object") return value || "";
  const m = String(value).trim().match(/^this\.item\.(\w+)$/);
  return m ? (loopItem[m[1]] ?? "") : value;
}

function generateCss(node, cssRules, loopSuffixes = null) {
  if (!node) return;
  let suffixes = loopSuffixes;
  const loopArr = node.loopType ? getLoopArr(node) : [];
  if (loopArr.length && !suffixes) suffixes = loopArr.map((_,i) => String(i));
  const nodeProps = node.props || {};
  const className = nodeProps.className;
  if (className) {
    const flexCls = getFlexClasses(node);
    const styles = cleanStyles(node, flexCls);
    const entries = Object.entries(styles);
    let content = "";
    if (entries.length || node.type === "lanhutext") {
      content = entries
        .map(([k,v]) => { const val = formatCssValue(k,v); return val ? `  ${camelToKebab(k)}: ${val};` : null; })
        .filter(Boolean).join("\n");
    }
    if (suffixes) for (const suf of suffixes) cssRules[`${className}-${suf}`] = content;
    else cssRules[className] = content;
  }
  for (const child of node.children||[]) generateCss(child, cssRules, suffixes);
}

function generateHtml(node, indent = 2, loopContext = null) {
  if (!node) return "";
  const [loopArr, loopIndex] = loopContext || [null, null];
  const loopItem = loopArr && loopIndex !== null ? loopArr[loopIndex] : null;
  const sp = " ".repeat(indent);
  const flexCls = getFlexClasses(node);
  const nodeProps = node.props || {};
  let cls = nodeProps.className || "";
  if (loopIndex !== null && cls) cls = `${cls}-${loopIndex}`;
  const allCls = [cls, ...flexCls].filter(Boolean).join(" ");
  const type = node.type;
  const LRE = /^this\.item\.\w+$/;

  if (type === "lanhutext") {
    let text = node.data?.value || nodeProps.text || "";
    if (loopItem && text && LRE.test(String(text).trim())) text = resolveLoopPlaceholder(text, loopItem);
    else if (text && LRE.test(String(text).trim())) text = "";
    return `${sp}<span class="${allCls}">${text}</span>`;
  }
  if (type === "lanhuimage") {
    let src = node.data?.value || nodeProps.src || "";
    if (loopItem && src && LRE.test(String(src).trim())) src = resolveLoopPlaceholder(src, loopItem);
    else if (src && LRE.test(String(src).trim())) src = "";
    return `${sp}<img\n${sp}  class="${allCls}"\n${sp}  referrerpolicy="no-referrer"\n${sp}  src="${src}"\n${sp}/>`;
  }
  if (type === "lanhubutton") {
    const ch = (node.children||[]).map(c=>generateHtml(c,indent+2,loopContext)).join("\n");
    return `${sp}<button class="${allCls}">\n${ch}\n${sp}</button>`;
  }
  const children = node.children || [];
  const nla = node.loopType ? getLoopArr(node) : [];
  if (nla.length && !loopContext) {
    const parts = [];
    for (let i=0; i<nla.length; i++) for (const c of children) parts.push(generateHtml(c,indent+2,[nla,i]));
    return `${sp}<div class="${allCls}">\n${parts.join("\n")}\n${sp}</div>`;
  }
  if (children.length) {
    const ch = children.map(c=>generateHtml(c,indent+2,loopContext)).join("\n");
    return `${sp}<div class="${allCls}">\n${ch}\n${sp}</div>`;
  }
  return `${sp}<div class="${allCls}"></div>`;
}

// ── DDS Schema → HTML+CSS（主路径） ───────────────────────────────────────────

export function convertLanhuToHtml(jsonData) {
  const cssRules = {};
  generateCss(jsonData, cssRules);
  const css = Object.entries(cssRules)
    .map(([cls,props]) => props ? `.${cls} {\n${props}\n}` : `.${cls} {\n}`)
    .join("\n\n") + COMMON_CSS_FOR_DESIGN;
  const body = generateHtml(jsonData, 4);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Document</title>
    <style>
${css}
    </style>
  </head>
  <body>
${body}
  </body>
</html>`;
}

// ── Design Tokens 提取（共用，交叉验证高风险元素） ─────────────────────────────

const SKETCH_NOISE_TYPES = new Set(["artboard","page","symbolMaster","slice","MSImmutableHotspotLayer","hotspot"]);

export function extractDesignTokens(sketchData) {
  function getDims(obj) {
    const f = obj.frame || obj.realFrame || {};
    return [obj.left??f.left??0, obj.top??f.top??0, obj.width??f.width??0, obj.height??f.height??0];
  }
  function simplifyFill(f) {
    if (!f || f.isEnabled === false) return null;
    if (f.fillType === 1) {
      const grad = f.gradient || {};
      const stops = (grad.stops||[]).map(s => {
        const c = s.color||{}; const r=Math.round(c.red??c.r??0),g=Math.round(c.green??c.g??0),b=Math.round(c.blue??c.b??0);
        return `rgba(${r},${g},${b},${s.position??0})`;
      }).join(", ");
      const angle = grad.gradientType===0 ? `${Math.round(grad.rotation||0)}deg` : "to right";
      return `linear-gradient(${angle}, ${stops})`;
    }
    const c = f.color||{}; if (!c||!Object.keys(c).length) return null;
    const r=Math.round(c.red??c.r??0),g=Math.round(c.green??c.g??0),b=Math.round(c.blue??c.b??0),a=c.alpha??1;
    return a<1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
  }
  function simplifyBorder(b) {
    if (!b||b.isEnabled===false) return null;
    const c=b.color||{}; const r=Math.round(c.red??c.r??0),g=Math.round(c.green??c.g??0),bv=Math.round(c.blue??c.b??0);
    return `${b.thickness??b.width??1}px solid rgb(${r},${g},${bv})`;
  }
  function simplifyShadow(s) {
    if (!s||s.isEnabled===false) return null;
    const c=s.color||{}; const r=Math.round(c.red??c.r??0),g=Math.round(c.green??c.g??0),b=Math.round(c.blue??c.b??0),a=c.alpha??1;
    const col = a<1?`rgba(${r},${g},${b},${a})`:`rgb(${r},${g},${b})`;
    return `${col} ${s.offsetX??s.x??0}px ${s.offsetY??s.y??0}px ${s.blurRadius??s.blur??0}px`;
  }
  function hasOnlyTransparentSolid(fills) {
    if (!fills||!fills.length) return true;
    return fills.every(f => f.isEnabled===false || (f.fillType===0 && (f.color?.alpha??1)===0));
  }
  function isHighRisk(obj) {
    const t = (obj.type||obj.ddsType||"").toLowerCase();
    if (SKETCH_NOISE_TYPES.has(t)) return false;
    const [,,w,h] = getDims(obj);
    if (w<2&&h<2) return false;
    const fills = obj.fills||[];
    if (fills.some(f=>f.isEnabled!==false&&f.fillType===1)) return true;
    if ((obj.borders||[]).some(b=>b.isEnabled!==false)) return true;
    const radius = obj.radius;
    if (Array.isArray(radius)&&new Set(radius).size>1) return true;
    const op = obj.opacity;
    if (op!==undefined&&op<100) {
      if (hasOnlyTransparentSolid(fills)&&!(obj.borders||[]).length&&!(obj.shadows||[]).length) return false;
      return true;
    }
    if ((obj.shadows||[]).some(s=>s.isEnabled!==false)) return true;
    return false;
  }
  const tokens = [];
  function walk(obj, parentPath = "") {
    if (!obj||typeof obj!=="object"||obj.isVisible===false) return;
    const name = obj.name||"";
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (isHighRisk(obj)) {
      const t = obj.type||obj.ddsType||"unknown";
      const [x,y,w,h] = getDims(obj);
      const lines = [`[${t}] "${name}" @(${Math.round(x)},${Math.round(y)}) ${Math.round(w)}x${Math.round(h)}${parentPath?`  path: ${path}`:""}`];
      const radius = obj.radius;
      if (radius!==undefined) lines.push(`  radius: ${Array.isArray(radius)?(new Set(radius).size===1?radius[0]:JSON.stringify(radius)):radius}`);
      for (const f of obj.fills||[]) { const s=simplifyFill(f); if(s) lines.push(`  fill: ${s}`); }
      for (const b of obj.borders||[]) { const s=simplifyBorder(b); if(s) lines.push(`  border: ${s}`); }
      if (obj.opacity!==undefined&&obj.opacity<100) lines.push(`  opacity: ${obj.opacity}%`);
      for (const sh of obj.shadows||[]) { const s=simplifyShadow(sh); if(s) lines.push(`  shadow: ${s}`); }
      tokens.push(lines.join("\n"));
    }
    for (const child of obj.layers||[]) walk(child, path);
  }
  if (sketchData.artboard?.layers) { for (const l of sketchData.artboard.layers) walk(l); }
  else if (sketchData.info) {
    for (const item of sketchData.info) {
      walk(item);
      for (const v of Object.values(item)) {
        if (typeof v==="object"&&v!==null) {
          if (Array.isArray(v)) v.forEach(i => typeof i==="object"&&i&&walk(i));
          else walk(v);
        }
      }
    }
  }
  return tokens.length ? tokens.join("\n\n") : "";
}

// ── Sketch JSON → 绝对定位 HTML（降级路径） ──────────────────────────────────

const SKETCH_SKIP_TYPES = new Set(["artboard","page","symbolMaster","slice","MSImmutableHotspotLayer","hotspot","group"]);

function sketchColor(c, alpha) {
  if (!c) return "transparent";
  const a = alpha ?? c.alpha ?? 1;
  const r=Math.round((c.red??c.r??0)*255), g=Math.round((c.green??c.g??0)*255), b=Math.round((c.blue??c.b??0)*255);
  return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

function sketchFillCss(fills) {
  if (!fills || !fills.length) return "";
  const enabled = fills.filter(f => f.isEnabled !== false);
  if (!enabled.length) return "";
  const f = enabled[enabled.length - 1];
  if (f.fillType === 1) {
    const grad = f.gradient || {};
    const stops = (grad.stops || []).map(s => {
      const pct = Math.round((s.position || 0) * 100);
      return `${sketchColor(s.color)} ${pct}%`;
    }).join(", ");
    const angle = grad.gradientType === 0 ? `${Math.round(grad.rotation || 0)}deg` : "to right";
    return `background: linear-gradient(${angle}, ${stops});`;
  }
  return `background-color: ${sketchColor(f.color)};`;
}

function sketchBorderCss(borders) {
  if (!borders || !borders.length) return "";
  const b = borders.find(b => b.isEnabled !== false);
  if (!b) return "";
  const w = b.thickness ?? b.width ?? 1;
  return `border: ${w}px solid ${sketchColor(b.color)};`;
}

function sketchRadiusCss(radius) {
  if (radius === undefined || radius === null) return "";
  if (Array.isArray(radius)) {
    if (new Set(radius).size === 1) return radius[0] ? `border-radius: ${radius[0]}px;` : "";
    return `border-radius: ${radius.map(r => `${r}px`).join(" ")};`;
  }
  return radius ? `border-radius: ${radius}px;` : "";
}

function sketchShadowCss(shadows) {
  if (!shadows || !shadows.length) return "";
  const enabled = shadows.filter(s => s.isEnabled !== false);
  if (!enabled.length) return "";
  const parts = enabled.map(s => {
    const x=s.offsetX??s.x??0, y=s.offsetY??s.y??0, blur=s.blurRadius??s.blur??0, spread=s.spread??0;
    return `${x}px ${y}px ${blur}px ${spread}px ${sketchColor(s.color)}`;
  });
  return `box-shadow: ${parts.join(", ")};`;
}

function sketchTextCss(obj) {
  const ta = obj.textAlignment || obj.style?.textAlignment;
  const map = {0:"left",1:"right",2:"center",3:"justify"};
  const parts = [];
  if (map[ta]) parts.push(`text-align: ${map[ta]};`);
  const ts = obj.textStyle || obj.style?.textStyle || {};
  if (ts.fontSize) parts.push(`font-size: ${ts.fontSize}px;`);
  if (ts.fontWeight) parts.push(`font-weight: ${ts.fontWeight};`);
  if (ts.color) parts.push(`color: ${sketchColor(ts.color)};`);
  if (ts.lineHeight) parts.push(`line-height: ${ts.lineHeight}px;`);
  if (ts.letterSpacing) parts.push(`letter-spacing: ${ts.letterSpacing}px;`);
  return parts.join(" ");
}

function getSketchLayerCss(layer, scale) {
  const sc = scale || 1;
  const f = layer.frame || layer.realFrame || {};
  const left = Math.round((layer.left ?? f.left ?? 0) / sc);
  const top = Math.round((layer.top ?? f.top ?? 0) / sc);
  const w = Math.round((layer.width ?? f.width ?? 0) / sc);
  const h = Math.round((layer.height ?? f.height ?? 0) / sc);
  const parts = [
    `position: absolute; left: ${left}px; top: ${top}px; width: ${w}px; height: ${h}px;`,
  ];
  const fills = layer.fills || [];
  const fillCss = sketchFillCss(fills);
  if (fillCss) parts.push(fillCss);
  const borderCss = sketchBorderCss(layer.borders || []);
  if (borderCss) parts.push(borderCss);
  const radCss = sketchRadiusCss(layer.radius);
  if (radCss) parts.push(radCss);
  const shadowCss = sketchShadowCss(layer.shadows || []);
  if (shadowCss) parts.push(shadowCss);
  if (layer.opacity !== undefined && layer.opacity < 100) parts.push(`opacity: ${layer.opacity / 100};`);
  const t = (layer.type || layer.ddsType || "").toLowerCase();
  if (t === "text" || t === "shapepath" || t === "shape") {
    const txt = sketchTextCss(layer);
    if (txt) parts.push(txt);
  }
  return parts.join(" ");
}

function isImageLayer(layer) {
  const t = (layer.type || layer.ddsType || "").toLowerCase();
  return t === "bitmap" || t === "image" || (layer.imageData && !layer.layers);
}

function isTextLayer(layer) {
  const t = (layer.type || layer.ddsType || "").toLowerCase();
  return t === "text";
}

function getTextContent(layer) {
  return layer.content || layer.value || layer.attributedString?.string || layer.name || "";
}

function safeCls(name) {
  return String(name || "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z]/, "l$&");
}

function sketchLayersToHtml(layers, scale, indent) {
  const sp = " ".repeat(indent);
  const parts = [];
  for (const layer of layers || []) {
    if (layer.isVisible === false) continue;
    const t = (layer.type || layer.ddsType || "").toLowerCase();
    if (SKETCH_SKIP_TYPES.has(t) && !layer.layers) continue;
    const css = getSketchLayerCss(layer, scale);
    const cls = safeCls(layer.name);
    if (isImageLayer(layer)) {
      const src = layer.imageUrl || layer.src || "";
      parts.push(`${sp}<img class="${cls}" referrerpolicy="no-referrer" src="${src}" data-css="${css.replace(/"/g,"'")}" />`);
    } else if (isTextLayer(layer)) {
      const text = getTextContent(layer);
      parts.push(`${sp}<span class="${cls}" data-css="${css.replace(/"/g,"'")}">${text}</span>`);
    } else {
      const children = layer.layers ? sketchLayersToHtml(layer.layers, scale, indent + 2) : "";
      if (children) {
        parts.push(`${sp}<div class="${cls}" data-css="${css.replace(/"/g,"'")}">\n${children}\n${sp}</div>`);
      } else {
        parts.push(`${sp}<div class="${cls}" data-css="${css.replace(/"/g,"'")}">\n${sp}</div>`);
      }
    }
  }
  return parts.join("\n");
}

export function convertSketchToHtml(sketchData, designScale, designImgUrl) {
  const sc = designScale || 1;
  let artboardW = 375, artboardH = 667;
  let layers = [];
  if (sketchData.artboard) {
    const ab = sketchData.artboard;
    artboardW = Math.round((ab.width ?? ab.frame?.width ?? 375) / sc);
    artboardH = Math.round((ab.height ?? ab.frame?.height ?? 667) / sc);
    layers = ab.layers || [];
  } else if (sketchData.info && sketchData.info.length) {
    const first = sketchData.info[0];
    artboardW = Math.round((first.width ?? first.frame?.width ?? 375) / sc);
    artboardH = Math.round((first.height ?? first.frame?.height ?? 667) / sc);
    layers = first.layers || [];
  }
  const body = sketchLayersToHtml(layers, sc, 4);
  const bgStyle = designImgUrl
    ? `background-image: url('${designImgUrl}'); background-size: cover;`
    : "background: #f0f0f0;";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Design Spec</title>
    <style>
body { margin: 0; padding: 0; }
.artboard { position: relative; width: ${artboardW}px; height: ${artboardH}px; overflow: hidden; ${bgStyle} }
    </style>
  </head>
  <body>
    <div class="artboard">
${body}
    </div>
  </body>
</html>`;
}

// ── Sketch 结构化标注（降级路径文本输出） ─────────────────────────────────────

function annotateLayer(layer, scale, depth, lines) {
  if (!layer || layer.isVisible === false) return;
  const sc = scale || 1;
  const sp = "  ".repeat(depth);
  const f = layer.frame || layer.realFrame || {};
  const x = Math.round((layer.left ?? f.left ?? 0) / sc);
  const y = Math.round((layer.top ?? f.top ?? 0) / sc);
  const w = Math.round((layer.width ?? f.width ?? 0) / sc);
  const h = Math.round((layer.height ?? f.height ?? 0) / sc);
  const name = layer.name || "(unnamed)";
  const t = layer.type || layer.ddsType || "unknown";
  const cssParts = [];
  cssParts.push(`left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px`);
  const fillCss = sketchFillCss(layer.fills || []);
  if (fillCss) cssParts.push(fillCss.replace(/;$/, ""));
  const borderCss = sketchBorderCss(layer.borders || []);
  if (borderCss) cssParts.push(borderCss.replace(/;$/, ""));
  const radCss = sketchRadiusCss(layer.radius);
  if (radCss) cssParts.push(radCss.replace(/;$/, ""));
  const shadowCss = sketchShadowCss(layer.shadows || []);
  if (shadowCss) cssParts.push(shadowCss.replace(/;$/, ""));
  if (layer.opacity !== undefined && layer.opacity < 100) cssParts.push(`opacity: ${layer.opacity / 100}`);
  if (isTextLayer(layer)) {
    const txt = sketchTextCss(layer).replace(/;/g, "").trim();
    if (txt) cssParts.push(txt);
    const content = getTextContent(layer);
    if (content) cssParts.push(`content: "${content}"`);
  }
  lines.push(`${sp}[${t}] "${name}" { ${cssParts.join("; ")} }`);
  for (const child of layer.layers || []) annotateLayer(child, scale, depth + 1, lines);
}

export function extractFullAnnotationsFromSketch(sketchData, designScale) {
  const sc = designScale || 1;
  const lines = [];
  let layers = [];
  if (sketchData.artboard) {
    layers = sketchData.artboard.layers || [];
  } else if (sketchData.info && sketchData.info.length) {
    layers = sketchData.info[0].layers || [];
  }
  for (const layer of layers) annotateLayer(layer, sc, 0, lines);
  return lines.join("\n");
}

// ── HTML 压缩 & 图片本地化 ─────────────────────────────────────────────────────

export function minifyHtml(html) {
  if (!html) return "";
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

export function localizeImageUrls(htmlCode, designName) {
  if (!htmlCode) return { html: htmlCode, mapping: {} };
  const safeDesign = String(designName || "design").replace(/[^A-Za-z0-9_-]/g, "_");
  const mapping = {};
  const counter = {};
  const result = htmlCode.replace(/src="(https?:\/\/[^"]+)"/g, (match, url) => {
    let ext = ".png";
    try { const u = new URL(url); const e = u.pathname.split(".").pop().toLowerCase(); if (["png","jpg","jpeg","webp","gif","svg"].includes(e)) ext = `.${e}`; } catch {}
    const urlKey = url.split("?")[0].split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_") || "img";
    const stem = urlKey.replace(/\.[^.]+$/, "");
    counter[stem] = (counter[stem] || 0) + 1;
    const localName = counter[stem] > 1 ? `${stem}_${counter[stem]}${ext}` : `${stem}${ext}`;
    const localPath = `./assets/slices/${localName}`;
    mapping[localPath] = url;
    return `src="${localPath}"`;
  });
  return { html: result, mapping };
}

