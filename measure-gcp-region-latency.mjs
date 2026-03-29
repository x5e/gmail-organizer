#!/usr/bin/env node

import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";

const REGIONS = [
  "africa-south1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-south2",
  "asia-southeast1",
  "asia-southeast2",
  "asia-southeast3",
  "australia-southeast1",
  "australia-southeast2",
  "europe-central2",
  "europe-north1",
  "europe-north2",
  "europe-southwest1",
  "europe-west1",
  "europe-west10",
  "europe-west12",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "me-central1",
  "me-central2",
  "me-west1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "northamerica-south1",
  "southamerica-east1",
  "southamerica-west1",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
];

const defaults = {
  service: "logging",
  tcpSamples: 4,
  pingCount: 5,
  shortlistSize: 10,
  connectTimeoutMs: 3000,
};

function parseArgs(argv) {
  const options = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--service" && next) {
      options.service = next;
      index += 1;
      continue;
    }

    if (arg === "--tcp-samples" && next) {
      options.tcpSamples = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--ping-count" && next) {
      options.pingCount = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--shortlist" && next) {
      options.shortlistSize = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node measure-gcp-region-latency.mjs [options]

Options:
  --service <name>      Regional Google API service to probe (default: logging)
  --tcp-samples <n>     TCP connect samples per region (default: 4)
  --ping-count <n>      ICMP echo requests for shortlisted regions (default: 5)
  --shortlist <n>       Number of regions to confirm with ping (default: 10)
  --help, -h            Show this help text
`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

function connectTime(host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const socket = net.connect({ host, port: 443 });

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      cleanup();
      resolve(elapsedMs);
    });

    socket.once("timeout", () => {
      cleanup();
      reject(new Error("connect timeout"));
    });

    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function resolveIpv4(host) {
  const result = await dns.lookup(host, { family: 4 });
  return result.address;
}

async function benchmarkRegion(region, options) {
  const host = `${options.service}.${region}.rep.googleapis.com`;
  const ip = await resolveIpv4(host);
  const tcpTimes = [];

  for (let index = 0; index < options.tcpSamples; index += 1) {
    tcpTimes.push(await connectTime(host, options.connectTimeoutMs));
  }

  return {
    region,
    host,
    ip,
    tcpMedianMs: median(tcpTimes),
    tcpMinMs: Math.min(...tcpTimes),
    tcpMaxMs: Math.max(...tcpTimes),
  };
}

function pingRegion(ip, count) {
  return new Promise((resolve, reject) => {
    const child = spawn("ping", ["-c", String(count), "-q", ip], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `ping exited with code ${code}`));
        return;
      }

      const match = stdout.match(
        /round-trip min\/avg\/max\/(?:stddev|mdev) = ([0-9.]+)\/([0-9.]+)\/([0-9.]+)\//
      );

      if (!match) {
        reject(new Error("unable to parse ping summary"));
        return;
      }

      resolve({
        minMs: Number.parseFloat(match[1]),
        avgMs: Number.parseFloat(match[2]),
        maxMs: Number.parseFloat(match[3]),
      });
    });
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;

      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = { error, item: items[currentIndex] };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );

  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log(
    `Benchmarking ${REGIONS.length} GCP regions using ${options.service} regional endpoints...`
  );

  const tcpResults = await mapWithConcurrency(REGIONS, 8, async (region) =>
    benchmarkRegion(region, options)
  );

  const successfulTcpResults = tcpResults
    .filter((result) => result && !("error" in result))
    .sort((left, right) => left.tcpMedianMs - right.tcpMedianMs);

  const failedRegions = tcpResults.filter((result) => result && "error" in result);

  if (successfulTcpResults.length === 0) {
    throw new Error("No regional endpoints responded.");
  }

  console.log("");
  console.log("TCP shortlist:");

  const shortlist = successfulTcpResults.slice(
    0,
    Math.min(options.shortlistSize, successfulTcpResults.length)
  );

  for (const result of shortlist) {
    console.log(
      `${result.region.padEnd(24)} ${formatMs(result.tcpMedianMs).padStart(10)}  ${result.ip}`
    );
  }

  console.log("");
  console.log(`Confirming top ${shortlist.length} with ping...`);

  const pingResults = [];

  for (const result of shortlist) {
    try {
      const ping = await pingRegion(result.ip, options.pingCount);
      pingResults.push({ ...result, ping });
    } catch (error) {
      pingResults.push({ ...result, pingError: error });
    }
  }

  const successfulPingResults = pingResults
    .filter((result) => !result.pingError)
    .sort((left, right) => left.ping.avgMs - right.ping.avgMs);

  console.log("");
  console.log("Ping ranking:");

  for (const [index, result] of successfulPingResults.entries()) {
    console.log(
      `${String(index + 1).padStart(2)}. ${result.region.padEnd(24)} ${formatMs(
        result.ping.avgMs
      ).padStart(10)}  min=${formatMs(result.ping.minMs)}  max=${formatMs(
        result.ping.maxMs
      )}  ${result.ip}`
    );
  }

  const pingFailures = pingResults.filter((result) => result.pingError);
  if (pingFailures.length > 0) {
    console.log("");
    console.log("Ping failed for:");
    for (const result of pingFailures) {
      console.log(`- ${result.region}: ${result.pingError.message}`);
    }
  }

  if (failedRegions.length > 0) {
    console.log("");
    console.log("Skipped regions:");
    for (const failed of failedRegions) {
      console.log(`- ${failed.item}: ${failed.error.message}`);
    }
  }

  if (successfulPingResults[0]) {
    const winner = successfulPingResults[0];
    console.log("");
    console.log(
      `Closest region from this network: ${winner.region} (${formatMs(
        winner.ping.avgMs
      )} avg ping)`
    );
  } else {
    const winner = shortlist[0];
    console.log("");
    console.log(
      `Closest region from this network by TCP connect time: ${winner.region} (${formatMs(
        winner.tcpMedianMs
      )} median)`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
