// Déclare quiz-runner dans la config de Claude Desktop (macOS).
// À lancer quand Claude Desktop est fermé (⌘Q) : l'app réécrit ce fichier et écraserait la modification.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configPath = join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
const server = fileURLToPath(new URL("../src/stdio.ts", import.meta.url));

let running = false;
try {
  const script = 'application id "com.anthropic.claudefordesktop" is running';
  running = execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim() === "true";
} catch {
  // osascript indisponible : on ne bloque pas.
}
if (running && !process.argv.includes("--force")) {
  console.error("Claude Desktop est ouvert : quitte-le (⌘Q) puis relance cette commande depuis le Terminal.");
  process.exit(1);
}

const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.bak`);
config.mcpServers ??= {};
config.mcpServers["quiz-runner"] = {
  // Chemin absolu : Claude Desktop ne charge pas le PATH du shell.
  command: process.execPath,
  args: [server],
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`quiz-runner ajouté à ${configPath} (sauvegarde : .bak).`);
console.log("Ouvre Claude Desktop : il lance quiz-runner tout seul (pages du quiz sur http://localhost:3000).");
