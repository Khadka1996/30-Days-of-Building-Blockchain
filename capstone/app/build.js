// Bundle the two pages (viem + the Pramaan hashing library + QR code readers/writers) for the browser.
const path = require("node:path");
const esbuild = require("esbuild");

async function build({ quiet = false } = {}) {
  const r = await esbuild.build({
    entryPoints: [path.join(__dirname, "src/verify.js"), path.join(__dirname, "src/portal.js")],
    outdir: path.join(__dirname, "public/build"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    logLevel: quiet ? "error" : "info",
  });
  return r.metafile;
}

module.exports = { build };
if (require.main === module) build().catch((e) => { console.error(e); process.exit(1); });
