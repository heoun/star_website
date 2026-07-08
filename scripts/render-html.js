const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const headerTemplatePath = path.join(root, "partials", "site-header.html");
const sharedHeaderPattern = /^([ \t]*)<!--\s*SHARED_HEADER\s*(\{[\s\S]*?\})\s*-->$/gm;

const NAV_ITEMS = [
  { key: "home", label: "Home", route: "" },
  { key: "rent", label: "Rent", route: "rental/", className: "intent-nav" },
  { key: "buy", label: "Buy", route: "buy/", className: "intent-nav" },
  { key: "sell", label: "Sell", route: "contact-us/?intent=sell", className: "intent-nav", dataAttr: "data-sell-nav" },
  { key: "commercial", label: "Commercial", route: "commercial/", className: "intent-nav" },
  { key: "new-development", label: "New Development", route: "new-development/" },
  { key: "contact", label: "Contact Us", route: "contact-us/", dataAttr: "data-contact-nav" }
];

const allowedCurrentNav = new Set([...NAV_ITEMS.map((item) => item.key), null]);
let cachedHeaderTemplate = null;

function renderHtmlFile(filePath) {
  return renderHtml(fs.readFileSync(filePath, "utf8"), filePath);
}

function renderHtml(source, filePath = "<inline>") {
  return source.replace(sharedHeaderPattern, (_, indent, rawOptions) => {
    let options;

    try {
      options = JSON.parse(rawOptions);
    } catch (error) {
      throw new Error(`Invalid SHARED_HEADER config in ${filePath}: ${error.message}`);
    }

    return indentBlock(renderSharedHeader(options, filePath), indent);
  });
}

function renderSharedHeader(options, filePath) {
  const template = getHeaderTemplate();
  const context = buildHeaderContext(options, filePath);
  const desktopNavLinks = renderNavLinks(context, "desktop");
  const mobileNavLinks = renderNavLinks(context, "mobile");

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    switch (key) {
      case "brandHref":
        return context.brandHref;
      case "brandLabel":
        return context.brandLabel;
      case "logoSrc":
        return context.logoSrc;
      case "desktopNavLinks":
        return desktopNavLinks;
      case "mobileNavLinks":
        return mobileNavLinks;
      default:
        throw new Error(`Unknown header template token "${key}" in ${filePath}`);
    }
  });
}

function buildHeaderContext(options, filePath) {
  const depth = Number.isInteger(options.depth) ? options.depth : Number.parseInt(options.depth, 10);

  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`Invalid SHARED_HEADER depth in ${filePath}: ${options.depth}`);
  }

  const currentNav = options.currentNav ?? null;
  if (!allowedCurrentNav.has(currentNav)) {
    throw new Error(`Invalid SHARED_HEADER currentNav in ${filePath}: ${currentNav}`);
  }

  const basePrefix = "../".repeat(depth);

  return {
    depth,
    currentNav,
    basePrefix,
    brandHref: depth === 0 ? "#home" : basePrefix,
    brandLabel: depth === 0 ? "Back to top" : "Go to homepage",
    logoSrc: `${basePrefix}jpg/logo-primary.jpg`
  };
}

function renderNavLinks(context, mode) {
  const indent = mode === "desktop" ? "      " : "    ";

  return NAV_ITEMS.map((item) => {
    const attributes = [];
    if (item.className) attributes.push(`class="${item.className}"`);
    attributes.push(`href="${resolveNavHref(item, context)}"`);
    if (context.currentNav === item.key) attributes.push('aria-current="page"');
    if (item.dataAttr) attributes.push(item.dataAttr);
    return `${indent}<a ${attributes.join(" ")}>${item.label}</a>`;
  }).join("\n");
}

function resolveNavHref(item, context) {
  if (item.key === "home") {
    return context.depth === 0 ? "#home" : context.basePrefix;
  }

  if (item.key === "sell") {
    return context.currentNav === "contact" ? "./?intent=sell" : `${context.basePrefix}${item.route}`;
  }

  if (item.key === "contact") {
    return context.currentNav === "contact" ? "./" : `${context.basePrefix}${item.route}`;
  }

  if (context.depth > 0 && context.currentNav === item.key) {
    return "./";
  }

  return `${context.basePrefix}${item.route}`;
}

function getHeaderTemplate() {
  if (!cachedHeaderTemplate) {
    cachedHeaderTemplate = fs.readFileSync(headerTemplatePath, "utf8");
  }

  return cachedHeaderTemplate;
}

function indentBlock(block, indent) {
  return block
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : line))
    .join("\n");
}

module.exports = {
  renderHtml,
  renderHtmlFile
};
