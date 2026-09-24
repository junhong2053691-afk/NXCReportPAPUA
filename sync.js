#!/usr/bin/env node
const { runSync } = require("./server/services/sync");

const backfill = process.argv.includes("--backfill");
const txOnly = process.argv.includes("--tx-only");
const full = process.argv.includes("--full");

runSync({ backfill, txOnly, full, quick: !backfill && !full })
  .then((r) => {
    console.log("[sync] finished", r);
    process.exit(0);
  })
  .catch((e) => {
    console.error("[sync] failed:", e.message);
    process.exit(1);
  });
