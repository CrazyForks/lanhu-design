#!/usr/bin/env node

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDesignSchema } from "./lanhu-client.mjs";
import {
  convertLanhuToHtml,
  convertSketchToHtml,
  extractDesignTokens,
  extractFullAnnotationsFromSketch,
  minifyHtml,
  localizeImageUrls,
} from "./design-converter.mjs";

function usage() {
  return `usage: node scripts/get_design_specs.mjs <lanhu_url> --design <name_or_index> [--output <dir>] [--no-minify]

输出包含精确 HTML+CSS 规格的 JSON，可直接用于设计还原。

示例:
  node scripts/get_design_specs.mjs "https://lanhuapp.com/..." --design "首页设计"
  node scripts/get_design_specs.mjs "https://lanhuapp.com/..." --design 1 --output ./tmp/specs`;
}

const argv = process.argv.slice(2);
let url = "";
let designArg = "";
let outputDir = "";
let doMinify = true;

const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-h" || arg === "--help") { console.log(usage()); process.exit(0); }
  else if (arg === "--design") { designArg = argv[++i] || ""; }
  else if (arg === "--output") { outputDir = argv[++i] || ""; }
  else if (arg === "--no-minify") { doMinify = false; }
  else if (arg.startsWith("--")) { console.error(`未知参数: ${arg}`); process.exit(2); }
  else positionals.push(arg);
}

url = positionals[0] || "";

if (!url || !designArg) {
  console.error(usage());
  process.exit(2);
}

try {
  const { schema, sketchData, design, source, ddsError, designImageUrl, canvasSize } =
    await getDesignSchema(url, designArg);

  let html, imageUrlMapping;

  if (source === "dds" && schema) {
    const rawHtml = convertLanhuToHtml(schema);
    const minified = doMinify ? minifyHtml(rawHtml) : rawHtml;
    const localized = localizeImageUrls(minified, design.name);
    html = localized.html;
    imageUrlMapping = localized.mapping;
  } else {
    const scale = canvasSize.width > 750 ? 2 : 1;
    const rawHtml = convertSketchToHtml(sketchData, scale, designImageUrl);
    const minified = doMinify ? minifyHtml(rawHtml) : rawHtml;
    const localized = localizeImageUrls(minified, design.name);
    html = localized.html;
    imageUrlMapping = localized.mapping;
  }

  const designTokens = extractDesignTokens(sketchData);
  const sketchAnnotations = source === "sketch"
    ? extractFullAnnotationsFromSketch(sketchData, canvasSize.width > 750 ? 2 : 1)
    : "";

  const result = {
    status: "success",
    source,
    design_name: design.name,
    canvas_size: canvasSize,
    html,
    design_tokens: designTokens || null,
    sketch_annotations: sketchAnnotations || null,
    image_url_mapping: imageUrlMapping,
    total_images: Object.keys(imageUrlMapping).length,
    dds_error: ddsError || null,
  };

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const safeName = design.name.replace(/[^A-Za-z0-9一-鿿._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "design";
    const jsonPath = path.join(outputDir, `${safeName}_specs.json`);
    const htmlPath = path.join(outputDir, `${safeName}.html`);
    await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
    await writeFile(htmlPath, doMinify ? minifyHtml(html) : html, "utf8");
    console.error(`已保存规格 JSON: ${jsonPath}`);
    console.error(`已保存 HTML: ${htmlPath}`);
  }

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "error", message: error.message }));
  process.exit(1);
}
