import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const targets = [];

function collect(directory, extension) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      collect(path, extension);
    } else if (path.endsWith(extension)) {
      targets.push(path);
    }
  }
}

collect(join(root, "public"), ".js");
collect(join(root, "scripts"), ".mjs");

targets.sort();
for (const file of targets) {
  const display = relative(root, file);
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  console.log(`checked ${display}`);
}

const publicRoot = join(root, "public");
const publicTargets = targets.filter((file) => file.startsWith(publicRoot));
const forbiddenPatterns = [
  { label: "eval()", pattern: /\beval\s*\(/ },
  { label: "new Function()", pattern: /\bnew\s+Function\s*\(/ },
  { label: "document.write()", pattern: /\bdocument\.write\s*\(/ },
];

for (const file of publicTargets) {
  const source = readFileSync(file, "utf8");
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(source)) {
      throw new Error(`Security check failed: ${rule.label} found in ${relative(root, file)}.`);
    }
  }
}

const clientFactoryOwners = [];
for (const file of publicTargets) {
  const source = readFileSync(file, "utf8");
  const matches = source.match(/\bsupabase\.createClient\s*\(/g) || [];
  for (let index = 0; index < matches.length; index += 1) {
    clientFactoryOwners.push(relative(root, file).replaceAll("\\", "/"));
  }
}

if (
  clientFactoryOwners.length !== 1 ||
  clientFactoryOwners[0] !== "public/runtime.js"
) {
  throw new Error(
    `Architecture check failed: expected exactly one Supabase client creation in public/runtime.js; found ${clientFactoryOwners.length ? clientFactoryOwners.join(", ") : "none"}.`
  );
}

const obsoleteSyncHelper = publicTargets.find(
  (file) => relative(root, file).replaceAll("\\", "/") === "public/sync-stability.js"
);
if (obsoleteSyncHelper) {
  throw new Error("Architecture check failed: public/sync-stability.js must not be reintroduced; public/app.js owns task synchronisation.");
}

const syncTimerOwners = [];
const syncOverrideViolations = [];
const directTaskPollViolations = [];

for (const file of publicTargets) {
  const source = readFileSync(file, "utf8");
  const display = relative(root, file).replaceAll("\\", "/");

  const timerMatches = source.match(/\bsyncTimer\s*=\s*setInterval\s*\(/g) || [];
  for (let index = 0; index < timerMatches.length; index += 1) {
    syncTimerOwners.push(display);
  }

  if (/\bloadTasks\s*=(?!=)/.test(source)) {
    syncOverrideViolations.push(`${display} reassigns loadTasks`);
  }
  if (/\bhandleSession\s*=(?!=)/.test(source)) {
    syncOverrideViolations.push(`${display} reassigns handleSession`);
  }

  if (
    /setInterval\s*\(\s*[A-Za-z_$][\w$]*loadTasks\s*,/i.test(source) ||
    /setInterval\s*\(\s*\(\s*\)\s*=>\s*(?:\{\s*)?[A-Za-z_$][\w$]*loadTasks\s*\(/i.test(source)
  ) {
    directTaskPollViolations.push(display);
  }
}

if (syncOverrideViolations.length) {
  throw new Error(
    `Architecture check failed: core sync functions must not be monkey-patched: ${syncOverrideViolations.join("; ")}.`
  );
}

if (
  syncTimerOwners.length !== 1 ||
  syncTimerOwners[0] !== "public/app.js"
) {
  throw new Error(
    `Architecture check failed: expected exactly one core sync timer in public/app.js; found ${syncTimerOwners.length ? syncTimerOwners.join(", ") : "none"}.`
  );
}

if (directTaskPollViolations.length) {
  throw new Error(
    `Architecture check failed: task loaders must not be polled directly with setInterval; use the app.js recovery scheduler instead: ${directTaskPollViolations.join(", ")}.`
  );
}

const appSource = readFileSync(join(publicRoot, "app.js"), "utf8");
if (!/\bsyncTimer\s*=\s*setInterval\s*\(\s*\(\)\s*=>\s*\{[\s\S]{0,300}?scheduleTaskRefresh\(0\)[\s\S]{0,120}?\},\s*600000\s*\);/.test(appSource)) {
  throw new Error("Architecture check failed: app.js must keep one 10-minute recovery poll routed through scheduleTaskRefresh(0).");
}

const indexHtml = readFileSync(join(root, "public", "index.html"), "utf8");
if (/supabase-js@2(?:["'/]|$)/.test(indexHtml)) {
  throw new Error("Security check failed: Supabase JS must use an exact pinned version, not the floating @2 tag.");
}
if (!/@supabase\/supabase-js@\d+\.\d+\.\d+/.test(indexHtml)) {
  throw new Error("Security check failed: an exact Supabase JS version was not found in public/index.html.");
}

const headers = readFileSync(join(root, "public", "_headers"), "utf8");
for (const required of [
  "Content-Security-Policy:",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "frame-ancestors 'none'",
  "base-uri 'self'",
]) {
  if (!headers.includes(required)) {
    throw new Error(`Security check failed: public/_headers is missing ${required}`);
  }
}

console.log(`NM Planner syntax check passed for ${targets.length} JavaScript files.`);
console.log("NM Planner single Supabase client check passed.");
console.log("NM Planner task sync architecture check passed.");
console.log("NM Planner security regression checks passed.");
