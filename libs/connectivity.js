// libs/connectivity.js
//
// A best-effort check that this computer is offline.
//
// A seed phrase should be created on a computer that is NOT connected to the
// internet, so nobody else can ever see it. This check tries to open a plain
// connection to two well-known addresses. If either one succeeds, the computer
// is online, and the program refuses to continue.
//
// This can be fooled (for example by a very locked-down network that blocks
// both addresses while other traffic still flows), so it is a helpful
// reminder, not a guarantee. For real safety, physically disconnect the
// computer from the internet before making a real seed phrase.
//
// This is the only code in the whole program that touches the network, and it
// runs before any dice rolls have been collected - so there is never anything
// secret in memory for it to leak, even in principle.

"use strict";

const net = require("node:net");

function checkIfOneAddressIsReachable(address, port, timeoutInMilliseconds) {
  return new Promise(function (resolve) {
    const connection = net.createConnection({ host: address, port: port });
    let alreadyFinished = false;

    function finish(isReachable) {
      if (alreadyFinished) {
        return;
      }
      alreadyFinished = true;
      connection.destroy();
      resolve(isReachable);
    }

    connection.setTimeout(timeoutInMilliseconds);
    connection.on("connect", function () {
      finish(true);
    });
    connection.on("timeout", function () {
      finish(false);
    });
    connection.on("error", function () {
      finish(false);
    });
  });
}

async function isThisComputerOnline() {
  const timeoutInMilliseconds = 3000;
  const cloudflareIsReachable = await checkIfOneAddressIsReachable("1.1.1.1", 443, timeoutInMilliseconds);
  const googleIsReachable = await checkIfOneAddressIsReachable("8.8.8.8", 443, timeoutInMilliseconds);
  return cloudflareIsReachable || googleIsReachable;
}

module.exports = {
  isThisComputerOnline,
};
