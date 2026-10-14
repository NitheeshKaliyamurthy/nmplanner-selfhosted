import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const config = {
  supabaseUrl: process.env.VITE_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
  allowedEmail: (process.env.VITE_ALLOWED_EMAIL ?? "").trim().toLowerCase(),
};

await writeFile(
  resolve(output, "config.js"),
  `window.NMPLANNER_CONFIG = ${JSON.stringify(config)};\n`,
  "utf8",
);

console.log("NM Planner built in dist/");
