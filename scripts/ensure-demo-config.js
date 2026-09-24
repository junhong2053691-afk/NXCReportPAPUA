const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const dest = path.join(root, "config.demo.json");
const example = path.join(root, "config.demo.example.json");

if (fs.existsSync(dest)) {
  const cfg = JSON.parse(fs.readFileSync(dest, "utf8"));
  process.stdout.write(
    JSON.stringify({
      created: false,
      username: cfg.admin && cfg.admin.username,
      password: cfg.admin && cfg.admin.password,
      port: cfg.port || 3100,
    })
  );
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(example, "utf8"));
cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
cfg.admin.password = "Try-" + crypto.randomBytes(6).toString("base64url");
fs.writeFileSync(dest, JSON.stringify(cfg, null, 2) + "\n", "utf8");
process.stdout.write(
  JSON.stringify({
    created: true,
    username: cfg.admin.username,
    password: cfg.admin.password,
    port: cfg.port || 3100,
  })
);
