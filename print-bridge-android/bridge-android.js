#!/usr/bin/env node
"use strict";

// Madinah Market — Kitchen Print Bridge (Android / Termux)
// =========================================================
// A small, dependency-free program (Node.js built-ins only) that runs
// on the kitchen's Android tablet inside Termux. The website lives in
// the cloud and cannot see the restaurant's printer, so this bridge
// does two jobs:
//   1. It FINDS the Star ticket printer on the restaurant network
//      (a TCP probe of port 9100, the Star Line Mode raw port) and
//      reports it to the website, where staff confirm it in
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
const net = require("net");

const DEFAULT_SITE_URL = "https://www.taqwaacenter.com";
const LOOP_MS = 10_000;
const REDISCOVER_MS = 5 * 60 * 1000;
const PRINTER_PORT = 9100;
const PROBE_TIMEOUT_MS = 400;
const PROBE_CONCURRENCY = 32;
const PRINT_TIMEOUT_MS = 5_000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET = args.includes("--reset");
const configArg = args.indexOf("--config");
const CONFIG_PATH =
  configArg >= 0 && args[configArg + 1]
    ? path.resolve(args[configArg + 1])
    : path.join(__dirname, "bridge-config.json");

// The running config, kept in memory so the print path can save a
// rediscovered printer IP. Set by main() and by pair().
let activeConfig = null;
// IPs from the most recent discovery, used as the print fallback.
let lastDiscoveredIps = [];

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

function isValidIpv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || "").trim());
  if (!m) return false;
  return m.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function parseIpv4(text) {
  const m = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(String(text || ""));
  return m && isValidIpv4(m[0]) ? m[0] : null;
}

// The printer IP chosen outside the normal flow wins: the environment
// override first (used for testing), then the saved config value.
function configuredPrinterIp() {
  const envIp = process.env.MADINAH_PRINTER_IP;
  if (envIp && isValidIpv4(envIp)) return envIp.trim();
  if (activeConfig && typeof activeConfig.printer_ip === "string" && isValidIpv4(activeConfig.printer_ip)) {
    return activeConfig.printer_ip.trim();
  }
  return null;
}

function persistPrinterIp(ip) {
  if (!activeConfig || !isValidIpv4(ip)) return;
  activeConfig.printer_ip = ip;
  try {
    saveConfig(activeConfig);
  } catch {
    /* saving is best-effort; the in-memory value still applies */
  }
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
  console.log("Madinah Market — Print Bridge setup (Android)");
  console.log("=============================================");
  console.log("In Admin -> Operations -> Kitchen printer, press");
  console.log('"Generate pairing code", then type the code here.');
  console.log("");
  const reader = createLineReader();
  const siteAnswer = (await reader.ask(`Website address [${DEFAULT_SITE_URL}]: `)).trim();
  const siteUrl = (siteAnswer || DEFAULT_SITE_URL).replace(/\/+$/, "");
  const nameAnswer = (await reader.ask("Tablet name [kitchen-tablet]: ")).trim();
  const computerName = nameAnswer || "kitchen-tablet";
  const code = (await reader.ask("Pairing code (6 digits): ")).trim();
  if (!/^\d{6}$/.test(code)) {
    reader.close();
    throw new Error("That is not a 6-digit code — run the bridge again and retype it.");
  }
  const result = await api(siteUrl, null, {
    action: "pair",
    code,
    computer_name: computerName,
  });
  if (!result || typeof result.token !== "string" || !result.token) {
    reader.close();
    throw new Error("The website did not return a bridge token — pairing failed.");
  }
  const config = { site_url: siteUrl, token: result.token, computer_name: computerName };
  activeConfig = config;
  saveConfig(config);
  log(`Paired with ${siteUrl} as "${computerName}". Token saved to bridge-config.json.`);

  // Find the printer now so its IP can be confirmed and saved.
  console.log("");
  console.log("Looking for the Star printer on this network...");
  const found = await discoverPrinters();
  const foundIp = found.printers.length ? parseIpv4(found.printers[0].name) : null;
  const presetIp = foundIp || configuredPrinterIp() || "";
  const ipAnswer = (
    await reader.ask(
      presetIp
        ? `Printer IP [${presetIp}]: `
        : "Printer IP (blank = find it automatically each run): "
    )
  ).trim();
  reader.close();
  const chosenIp = ipAnswer || presetIp;
  if (chosenIp) {
    if (!isValidIpv4(chosenIp)) {
      throw new Error(`"${chosenIp}" is not a valid printer IP — run the bridge again and retype it.`);
    }
    config.printer_ip = chosenIp;
    saveConfig(config);
    log(`Printer IP saved: ${chosenIp}`);
  } else {
    log("No printer IP saved — the bridge will search the network on every run.");
  }
  return loadConfig();
}

// ---- Printer discovery (LAN scan of the Star raw port) --------------------------

function probePrinter(ip) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(ok);
    };
    const socket = net.connect({ host: ip, port: PRINTER_PORT });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function localSubnetPrefix() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const entry of list || []) {
      const family = entry && entry.family;
      if ((family === "IPv4" || family === 4) && entry && !entry.internal && isValidIpv4(entry.address)) {
        return entry.address.split(".").slice(0, 3).join(".");
      }
    }
  }
  return null;
}

async function scanSubnet(prefix) {
  const found = [];
  let nextHost = 1;
  async function worker() {
    while (nextHost <= 254) {
      const host = nextHost;
      nextHost += 1;
      const ip = `${prefix}.${host}`;
      if (await probePrinter(ip)) found.push(ip);
    }
  }
  const workers = [];
  for (let i = 0; i < PROBE_CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  found.sort((a, b) => Number(a.split(".")[3]) - Number(b.split(".")[3]));
  return found;
}

function printerEntry(ip, isDefault) {
  return { name: `STAR TSP143 \u2014 ${ip}`, is_default: isDefault, status: "Normal" };
}

async function discoverPrinters() {
  const configured = configuredPrinterIp();
  let ips = [];
  if (configured) {
    if (await probePrinter(configured)) ips = [configured];
  } else {
    const prefix = localSubnetPrefix();
    if (!prefix) {
      lastDiscoveredIps = [];
      return {
        printers: [],
        error: "Could not find this tablet's Wi-Fi address — is the tablet on the restaurant Wi-Fi?",
      };
    }
    ips = await scanSubnet(prefix);
  }
  lastDiscoveredIps = ips;
  if (!ips.length) {
    return {
      printers: [],
      error: configured
        ? `The saved printer (${configured}) did not answer on port ${PRINTER_PORT} — is it switched on and on this Wi-Fi?`
        : `No printer answered on port ${PRINTER_PORT} on this network — is the Star printer switched on and on this Wi-Fi?`,
    };
  }
  return {
    printers: ips.map((ip, idx) => printerEntry(ip, idx === 0)),
    error: null,
  };
}

// ---- Printing (raw TCP to the Star printer, Star Line Mode) ----------------------

const SMART_PUNCTUATION = {
  "\u2014": "-", // em dash
  "\u2013": "-", // en dash
  "\u2018": "'", // left single quote
  "\u2019": "'", // right single quote
  "\u201C": '"', // left double quote
  "\u201D": '"', // right double quote
  "\u2022": "-", // bullet
};

function ticketToPrinterBytes(ticketText) {
  const mapped = String(ticketText).replace(
    /[\u2014\u2013\u2018\u2019\u201C\u201D\u2022]/g,
    (ch) => SMART_PUNCTUATION[ch] || "?"
  );
  // Anything still non-ASCII (emoji, accented letters) cannot be
  // printed by the Star in line mode — replace it, keep the text.
  const ascii = mapped.replace(/[^\x00-\x7F]/g, "?");
  const body = Buffer.from(ascii + "\n\n\n", "ascii");
  const cut = Buffer.from([0x1b, 0x64, 0x02]); // ESC d 2 — partial cut
  return Buffer.concat([body, cut]);
}

function printOnce(ip, ticketText) {
  return new Promise((resolve, reject) => {
    const payload = ticketToPrinterBytes(ticketText);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      reject(err);
    };
    const socket = net.connect({ host: ip, port: PRINTER_PORT });
    socket.setTimeout(PRINT_TIMEOUT_MS);
    socket.once("timeout", () =>
      fail(new Error(`Printer at ${ip} did not answer in ${PRINT_TIMEOUT_MS / 1000}s`))
    );
    socket.once("error", (err) => fail(new Error(`Could not print to ${ip}: ${err.message}`)));
    socket.once("connect", () => {
      socket.end(payload, () => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
        resolve();
      });
    });
  });
}

async function resolveTargetIp(printerName) {
  const fromName = parseIpv4(printerName);
  if (fromName) return fromName;
  const configured = configuredPrinterIp();
  if (configured) return configured;
  if (lastDiscoveredIps.length) return lastDiscoveredIps[0];
  const found = await discoverPrinters();
  return found.printers.length ? parseIpv4(found.printers[0].name) : null;
}

async function printTicket(ticketText, printerName, copies) {
  const n = Math.min(3, Math.max(1, Math.floor(copies) || 1));
  const ip = await resolveTargetIp(printerName);
  if (!ip) {
    throw new Error("No Star printer found on this network — nothing was printed.");
  }
  try {
    for (let i = 0; i < n; i++) {
      await printOnce(ip, ticketText);
    }
  } catch (firstErr) {
    // The printer may have moved to a new IP (DHCP). Search the
    // network once; if a printer answers somewhere new, save that
    // IP and retry the whole ticket once. Otherwise give up so the
    // job acks ok=false and the server retries/parks it as usual.
    const found = await discoverPrinters();
    const newIp = found.printers.length ? parseIpv4(found.printers[0].name) : null;
    if (!newIp || newIp === ip) throw firstErr;
    log(`Printer moved: ${ip} -> ${newIp}. Saving the new IP and retrying.`);
    persistPrinterIp(newIp);
    for (let i = 0; i < n; i++) {
      await printOnce(newIp, ticketText);
    }
  }
}

// ---- Main loop ---------------------------------------------------------------------------

async function handleJob(config, job) {
  activeConfig = config;
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
  activeConfig = config;
  log(
    `Bridge running for ${config.site_url} as "${config.computer_name || os.hostname()}".` +
      (DRY_RUN ? " (DRY-RUN — nothing will really print)" : "")
  );
  log("Leave this app open. Press Ctrl+C to stop.");

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
