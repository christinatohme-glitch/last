const fs = require("fs");
const path = require("path");

const pkg = require("./package.json");

function readJsonIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.warn("Could not read", filePath, err.message);
  }
  return null;
}

function injectDesktopShortcutExtension(manifestPath) {
  let xml = fs.readFileSync(manifestPath, "utf8");
  const desktop7Ns = 'xmlns:desktop7="http://schemas.microsoft.com/appx/manifest/desktop/windows10/7"';
  if (!xml.includes("xmlns:desktop7")) {
    xml = xml.replace("<Package ", `<Package ${desktop7Ns} `);
  }

  if (xml.includes('Category="windows.shortcut"')) {
    fs.writeFileSync(manifestPath, xml, "utf8");
    return;
  }

  const extensionPath = path.join(__dirname, "build", "msix-desktop-shortcut.xml");
  const extensionXml = fs.readFileSync(extensionPath, "utf8").trim();
  const wrapped = `<Extensions>\n${extensionXml}\n</Extensions>`;

  if (xml.includes("</Applications>")) {
    xml = xml.replace("</Applications>", `</Applications>\n${wrapped}`);
  } else {
    xml = xml.replace("</Package>", `${wrapped}\n</Package>`);
  }

  fs.writeFileSync(manifestPath, xml, "utf8");
}

const publisherConfig = readJsonIfExists(path.join(__dirname, "store-publisher.config.json")) || {};
const builtMsix = readJsonIfExists(path.join(__dirname, "build", "msix-build.config.json"));
const baseMsix = (builtMsix && builtMsix.msix) || pkg.build.msix || {};

const msix = {
  ...baseMsix,
  identityName: publisherConfig.identityName || baseMsix.identityName || "Talyfocous",
  publisher: process.env.VISIONBOOKS_STORE_PUBLISHER
    || publisherConfig.publisher
    || baseMsix.publisher,
  publisherDisplayName: publisherConfig.publisherDisplayName || baseMsix.publisherDisplayName || "Talyfocous",
  applicationId: publisherConfig.applicationId || baseMsix.applicationId || "Talyfocous",
  displayName: publisherConfig.displayName || baseMsix.displayName || "Talyfocous",
  languages: baseMsix.languages || ["en-US"],
  showNameOnTiles: baseMsix.showNameOnTiles !== false,
  customExtensionsPath: baseMsix.customExtensionsPath || "build/msix-desktop-shortcut.xml"
};

const extraResources = [...(pkg.build.extraResources || [])].filter((entry) => {
  if (!entry || typeof entry !== "object") return true;
  const from = String(entry.from || "");
  if (!from.includes("StoreBridge.exe")) return true;
  return fs.existsSync(path.join(__dirname, from));
});
const storeConfigPath = path.join(__dirname, "store.config.json");
if (fs.existsSync(storeConfigPath)) {
  extraResources.push({
    from: "store.config.json",
    to: "store.config.json"
  });
}

const { msix: _pkgMsix, ...baseBuild } = pkg.build;

/** @type {import("electron-builder").Configuration} */
module.exports = {
  ...baseBuild,
  extraResources,
  win: {
    ...(pkg.build.win || {}),
    target: [{ target: "appx", arch: ["x64"] }],
    icon: pkg.build.icon || "build/icon.ico",
    signAndEditExecutable: false
  },
  appx: {
    publisher: msix.publisher,
    identityName: msix.identityName,
    publisherDisplayName: msix.publisherDisplayName,
    applicationId: msix.applicationId,
    displayName: msix.displayName,
    languages: msix.languages,
    showNameOnTiles: msix.showNameOnTiles
  },
  forceCodeSigning: false
};
