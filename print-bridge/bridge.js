#!/usr/bin/env node
"use strict";

// Madinah Market — Kitchen Print Bridge
// =====================================
// A small, dependency-free program (Node.js built-ins only) that runs
// on the kitchen computer. The website lives in the cloud and cannot
// see the restaurant's printers, so this bridge does two jobs:
//   1. It FINDS the printers on this computer and reports them to the
//      website, where staff pick the ticket printer in
//      Admin -> Operations -> Kitchen printer.
//   2. It PRINTS each paid order's ticket by itself — no browser page
//      needs to stay open. Every order is printed exactly once: the
//      server only hands out unprinted orders, and this bridge
//      confirms ("acks") each print.
//
// Pairing: the first run asks for the 6-digit code shown in Admin and
// exchanges it for a bridge token, saved in bridge-config.json next
// to this file. The token is never printed to the console.
//
// Flags:
//   --dry-run        log what WOULD print instead of printing
//                    (for testing; prints are still confirmed to the
//                    server, so do not use it in real service)
//   --config <path>  use a different config file
//   --reset          forget the saved pairing and pair again

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

const DEFAULT_SITE_URL = "https://www.taqwaacenter.com";
const LOOP_MS = 10_000;
const REDISCOVER_MS = 5 * 60 * 1000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET = args.includes("--reset");
const configArg = args.indexOf("--config");
const CONFIG_PATH =
  configArg >= 0 && args[configArg + 1]
    ? path.resolve(args[configArg + 1])
    : path.join(__dirname, "bridge-config.json");

function log(message) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${stamp}] ${message}`);
}

// ---- Config -----------------------------------------------------------------

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.site_url === "string" && typeof parsed.token === "string") {
      return parsed;
    }
  } catch {
    /* missing or unreadable -> pair from scratch */
  }
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---- Website API ---------------------------------------------------------------

function api(siteUrl, token, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL("/api/bridge", siteUrl);
    } catch {
      reject(new Error(`Bad site URL: ${siteUrl}`));
      return;
    }
    const payload = JSON.stringify(body);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(token ? { "x-bridge-token": token } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            /* non-JSON response */
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ?? {});
          } else {
            const message =
              (data && typeof data.error === "string" && data.error) ||
              `Website answered HTTP ${res.statusCode}`;
            const err = new Error(message);
            err.status = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Website request timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---- Pairing (first run) ---------------------------------------------------------

// A tiny line reader over stdin. (Sequential readline.question calls
// can swallow lines that arrive together — e.g. pasted input — so the
// questions are served from an explicit line buffer instead. Works
// the same on an interactive console and on piped input.)
function createLineReader() {
  let buffer = "";
  const queued = [];
  const waiters = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (waiters.length) waiters.shift()(line);
      else queued.push(line);
    }
  });
  return {
    ask(question) {
      process.stdout.write(question);
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      process.stdin.pause();
    },
  };
}

async function pair() {
  console.log("");
  console.log("Madinah Market — Print Bridge setup");
  console.log("===================================");
  console.log("In Admin -> Operations -> Kitchen printer, press");
  console.log('"Generate pairing code", then type the code here.');
  console.log("");
  const reader = createLineReader();
  const siteAnswer = (await reader.ask(`Website address [${DEFAULT_SITE_URL}]: `)).trim();
  const siteUrl = (siteAnswer || DEFAULT_SITE_URL).replace(/\/+$/, "");
  const code = (await reader.ask("Pairing code (6 digits): ")).trim();
  reader.close();
  if (!/^\d{6}$/.test(code)) {
    throw new Error("That is not a 6-digit code — run the bridge again and retype it.");
  }
  const computerName = os.hostname();
  const result = await api(siteUrl, null, {
    action: "pair",
    code,
    computer_name: computerName,
  });
  if (!result || typeof result.token !== "string" || !result.token) {
    throw new Error("The website did not return a bridge token — pairing failed.");
  }
  saveConfig({ site_url: siteUrl, token: result.token, computer_name: computerName });
  log(`Paired with ${siteUrl} as "${computerName}". Token saved to bridge-config.json.`);
  return loadConfig();
}

// ---- Printer discovery (Windows) ----------------------------------------------------

const DISCOVER_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$def = (Get-CimInstance -ClassName Win32_Printer -Filter \"Default = TRUE\" -ErrorAction SilentlyContinue).Name",
  "$list = Get-Printer | ForEach-Object { [PSCustomObject]@{ name = $_.Name; is_default = ($_.Name -eq $def); status = $(if ($_.WorkOffline) { 'Offline' } else { [string]$_.PrinterStatus }) } }",
  "@($list) | ConvertTo-Json -Compress",
].join("; ");

function discoverPrinters() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({
        printers: [],
        error: `Printer discovery needs Windows (this is ${process.platform})`,
      });
      return;
    }
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", DISCOVER_PS],
      { timeout: 25_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ printers: [], error: `Printer search failed: ${err.message}` });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim() || "[]");
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          const printers = rows
            .filter((r) => r && typeof r.name === "string" && r.name.trim())
            .map((r) => ({
              name: String(r.name).trim(),
              is_default: r.is_default === true,
              status: typeof r.status === "string" && r.status ? r.status : "Unknown",
            }));
          resolve({ printers, error: null });
        } catch (parseErr) {
          resolve({
            printers: [],
            error: `Could not read the printer list: ${parseErr.message}`,
          });
        }
      }
    );
  });
}

// ---- Printing (Windows) ---------------------------------------------------------------

function psQuote(text) {
  // Single-quoted PowerShell string: double any single quotes.
  return `'${String(text).replace(/'/g, "''")}'`;
}

function printOnce(filePath, printerName) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error(`Printing needs Windows (this is ${process.platform})`));
      return;
    }
    const target = printerName ? ` -Name ${psQuote(printerName)}` : "";
    const script = `Get-Content -LiteralPath ${psQuote(filePath)} -Raw | Out-Printer${target}`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 30_000, windowsHide: true },
      (err) => {
        if (err) reject(new Error(`Print command failed: ${err.message}`));
        else resolve();
      }
    );
  });
}

async function printTicket(ticketText, printerName, copies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madinah-ticket-"));
  const file = path.join(dir, "ticket.txt");
  try {
    fs.writeFileSync(file, ticketText, "utf8");
    const n = Math.min(3, Math.max(1, Math.floor(copies) || 1));
    for (let i = 0; i < n; i++) {
      await printOnce(file, printerName);
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

// ---- Main loop ---------------------------------------------------------------------------

async function handleJob(config, job) {
  const label = job.kind === "test" ? "TEST ticket" : `order ticket ${job.job_id}`;
  try {
    if (DRY_RUN) {
      log(`[dry-run] WOULD print ${label} to "${job.printer ?? "(default printer)"}" x${job.copies ?? 1}:`);
      console.log("----- ticket -----");
      console.log(job.ticket);
      console.log("------------------");
    } else {
      await printTicket(job.ticket, job.printer ?? null, job.copies ?? 1);
    }
    await api(config.site_url, config.token, { action: "ack", job_id: job.job_id, ok: true });
    log(`Printed ${label}.`);
  } catch (err) {
    log(`FAILED to print ${label}: ${err.message}`);
    try {
      await api(config.site_url, config.token, {
        action: "ack",
        job_id: job.job_id,
        ok: false,
        error: String(err.message || err).slice(0, 300),
      });
    } catch {
      /* the failure is retried on the next poll via the server */
    }
  }
}

async function main() {
  if (RESET) {
    try {
      fs.rmSync(CONFIG_PATH, { force: true });
      log("Saved pairing forgotten — pairing again.");
    } catch {
      /* nothing to forget */
    }
  }
  let config = loadConfig();
  if (!config) {
    config = await pair();
  }
  log(
    `Bridge running for ${config.site_url} as "${config.computer_name || os.hostname()}".` +
      (DRY_RUN ? " (DRY-RUN — nothing will really print)" : "")
  );
  log("Leave this window open. Press Ctrl+C to stop.");

  let lastDiscoveryAt = 0;
  let needDiscovery = true;
  let rescanWasRequested = false;
  let failStreak = 0;

  for (;;) {
    let delay = LOOP_MS;
    try {
      const syncBody = {
        action: "sync",
        computer_name: config.computer_name || os.hostname(),
      };
      if (needDiscovery || Date.now() - lastDiscoveryAt > REDISCOVER_MS) {
        const found = await discoverPrinters();
        lastDiscoveryAt = Date.now();
        needDiscovery = false;
        syncBody.printers = found.printers;
        if (rescanWasRequested) {
          syncBody.rescan_done = true;
          rescanWasRequested = false;
        }
        if (found.error) {
          log(`Printer search problem: ${found.error} (reporting an empty list)`);
        } else {
          log(
            `Found ${found.printers.length} printer(s): ` +
              (found.printers.map((p) => p.name).join(", ") || "none")
          );
        }
      }
      const sync = await api(config.site_url, config.token, syncBody);
      if (sync && sync.rescan_requested) {
        needDiscovery = true;
        rescanWasRequested = true;
      }
      const jobsResult = await api(config.site_url, config.token, { action: "jobs" });
      const jobs = jobsResult && Array.isArray(jobsResult.jobs) ? jobsResult.jobs : [];
      for (const job of jobs) {
        await handleJob(config, job);
      }
      failStreak = 0;
    } catch (err) {
      failStreak += 1;
      delay = Math.min(60_000, LOOP_MS * failStreak);
      if (err && err.status === 401) {
        log(
          "The website rejected this bridge's token. It was probably revoked in Admin. " +
            "Close this window, delete bridge-config.json, and run the bridge again to pair with a fresh code."
        );
      } else {
        log(`Check-in failed (${err.message}) — retrying in ${Math.round(delay / 1000)}s. Orders are safe on the website.`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

process.on("unhandledRejection", (err) => {
  log(`Unexpected problem (kept running): ${err && err.message ? err.message : err}`);
});

main().catch((err) => {
  console.error(`\nThe print bridge could not start: ${err.message}`);
  process.exit(1);
});
