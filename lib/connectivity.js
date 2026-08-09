// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * lib/connectivity.js
 *
 * Offline check — best-effort detection of whether this machine currently
 * has a working internet connection.
 *
 * The only networking code in this program lives here. It opens plain TCP
 * connections to two well-known IPs (1.1.1.1 and 8.8.8.8, port 443) and
 * immediately discards them — no data is sent beyond the TCP handshake,
 * and nothing related to dice input or the mnemonic ever touches this
 * code path (it hasn't been collected yet when the probe runs, see
 * dice-to-seed.js). This is a best-effort convenience check, not a
 * guarantee: a machine behind a filtered network could still be online
 * while both probes fail. For maximum assurance, physically
 * disconnect/disable networking on the machine before running this,
 * rather than relying on this check alone.
 */

// Node's built-in networking module — used only for the outbound connectivity probe described above.
const net = require("node:net");

// Attempts a raw TCP connection to a single host:port and resolves true/false depending on whether it
// connects before `timeoutMs` elapses. Never sends any data — the socket is destroyed the instant the
// outcome (connect, timeout, or error) is known.
function probeHost(host, port, timeoutMs) {
  return new Promise((resolve) => {
    // Starts an outbound TCP connection attempt to a fixed IP address (no DNS lookup involved).
    const socket = net.createConnection({ host, port });
    // Guards against calling `resolve` more than once (connect/timeout/error could otherwise race).
    let settled = false;
    // Shared cleanup: destroys the socket and resolves the promise exactly once.
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    // Caps how long we wait for a handshake before treating the host as unreachable.
    socket.setTimeout(timeoutMs);
    // A completed TCP handshake means this host is reachable, i.e. the machine is online.
    socket.once("connect", () => finish(true));
    // No response within timeoutMs — treat as unreachable.
    socket.once("timeout", () => finish(false));
    // Connection refused, network unreachable, etc. — treat as unreachable.
    socket.once("error", () => finish(false));
  });
}

// Best-effort check for whether this machine currently has a working internet connection. Probes two
// well-known, independently-operated IPs in parallel (Cloudflare and Google public DNS, port 443) so a
// single provider outage or block doesn't produce a false "offline" reading. Returns true if either
// probe succeeds. This cannot prove the machine is offline (a sufficiently filtered network could block
// both probes while other traffic still gets through) — see the header comment for that caveat.
async function checkInternetConnection(timeoutMs = 3000) {
  const results = await Promise.all([
    probeHost("1.1.1.1", 443, timeoutMs),
    probeHost("8.8.8.8", 443, timeoutMs),
  ]);
  return results.some(Boolean);
}

module.exports = {
  checkInternetConnection,
};
