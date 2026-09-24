const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 22) {
  console.error("Need Node.js 22+. Current:", process.version);
  console.error("Download: https://nodejs.org");
  process.exit(1);
}
