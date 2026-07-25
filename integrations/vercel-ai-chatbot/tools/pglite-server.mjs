// An in-process PostgreSQL server: PGlite (Postgres compiled to WASM) behind a
// real TCP listener that speaks the Postgres v3 wire protocol via pg-gateway.
//
// This exists so integration tests can point an unmodified app at a plain
// `postgres://` URL without Docker or a system Postgres install.
//
// Auth is `trust` (any user, any or no password). There is no TLS: an
// SSLRequest is refused with "N", so use the URL as-is or with
// `?sslmode=disable`/`?sslmode=prefer`. `sslmode=require` cannot work.
import net from "node:net";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { fromDuplexStream } from "pg-gateway/node";

const MSG_TERMINATE = 0x58; // frontend "X"
const MSG_READY_FOR_QUERY = 0x5a; // backend "Z"
const TXN_IDLE = 0x49; // ReadyForQuery status "I"

/** FIFO mutex; `acquire()` resolves with the matching release function. */
function createMutex() {
  let tail = Promise.resolve();
  return function acquire() {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const acquired = tail.then(() => release);
    tail = tail.then(() => held);
    return acquired;
  };
}

/**
 * Transaction status from the last ReadyForQuery in a backend response, or
 * null if the response contains none. Used to decide when a connection has
 * returned to an idle session state and can give up its lock.
 */
function lastTransactionStatus(response) {
  let status = null;
  let offset = 0;
  while (offset + 5 <= response.length) {
    const length =
      (response[offset + 1] << 24) |
      (response[offset + 2] << 16) |
      (response[offset + 3] << 8) |
      response[offset + 4];
    if (length < 4) {
      break;
    }
    if (response[offset] === MSG_READY_FOR_QUERY && offset + 5 < response.length) {
      status = response[offset + 5];
    }
    offset += 1 + length;
  }
  return status;
}

/**
 * Adapt a Node socket to the web-stream duplex pg-gateway wants.
 *
 * We do this by hand rather than with `Duplex.toWeb()`: on Node 26 that
 * adapter throws `Cannot read properties of undefined (reading 'error')`
 * from its end-of-stream handler when a client disconnects, which crashes
 * the process on every normal `sql.end()`.
 */
function toDuplexStream(socket) {
  let closed = false;

  const readable = new ReadableStream({
    start(controller) {
      const finish = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      socket.on("data", (chunk) => {
        if (closed) {
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          socket.pause();
        }
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("error", finish);
    },
    pull() {
      socket.resume();
    },
    cancel() {
      socket.destroy();
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      if (socket.writableEnded || socket.destroyed) {
        return;
      }
      return new Promise((resolve) => {
        // Resolve on error too: a vanished client is not our problem.
        socket.write(chunk, () => resolve());
      });
    },
    close() {
      socket.end();
    },
    abort() {
      socket.destroy();
    },
  });

  return { readable, writable };
}

/**
 * Start an in-process Postgres server listening on TCP.
 *
 * @param {object} [options]
 * @param {number} [options.port] TCP port; 0 (default) picks a free one.
 * @param {string} [options.host] Bind address, defaults to 127.0.0.1.
 * @param {string} [options.dataDir] PGlite data dir; defaults to "memory://".
 * @param {object} [options.extensions] PGlite extensions, e.g.
 *   `{ pgcrypto }` from "@electric-sql/pglite/contrib/pgcrypto". None are
 *   loaded by default, so `CREATE EXTENSION` otherwise fails.
 * @returns {Promise<{ port: number, url: string, db: import("@electric-sql/pglite").PGlite, close: () => Promise<void> }>}
 */
export async function startPgliteServer(options = {}) {
  const {
    port = 0,
    host = "127.0.0.1",
    dataDir = "memory://",
    extensions,
  } = options;

  const db = new PGlite({ dataDir, extensions });
  await db.waitReady;

  const { rows } = await db.query("show server_version");
  const serverVersion = rows[0]?.server_version ?? "17.0";

  const acquire = createMutex();
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    // A dead client must never take the process down with it.
    socket.on("error", () => socket.destroy());

    // Pending lock for the batch/transaction this connection is in, if any.
    let lock = null;

    async function unlock() {
      if (lock) {
        const pending = lock;
        lock = null;
        (await pending)();
      }
    }

    socket.on("close", () => {
      sockets.delete(socket);
      // Never strand the mutex if the client vanishes mid-transaction.
      unlock();
    });

    fromDuplexStream(toDuplexStream(socket), {
      serverVersion,
      // Accept anything: the client may or may not offer a password, and
      // there is nothing to protect on a loopback-only test fixture.
      auth: { method: "trust" },
      // No `tls` option means pg-gateway answers an SSLRequest with "N", so
      // clients that merely prefer SSL fall back to plaintext cleanly.
      async onMessage(data, { isAuthenticated }) {
        if (!isAuthenticated) {
          return;
        }

        if (data[0] === MSG_TERMINATE) {
          await unlock();
          socket.end();
          return [];
        }

        // PGlite is a single Postgres backend shared by every connection, so
        // sessions must not interleave. Take the mutex on the first message
        // of a batch and hold it until the backend reports an idle session —
        // that keeps both extended-protocol sequences (Parse/Bind/Execute…)
        // and explicit BEGIN/COMMIT transactions atomic per connection.
        if (!lock) {
          lock = acquire();
        }
        await lock;

        let response;
        try {
          response = await db.execProtocolRaw(data);
        } catch (error) {
          await unlock();
          throw error;
        }

        if (lastTransactionStatus(response) === TXN_IDLE) {
          await unlock();
        }
        return response;
      },
    }).catch(() => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // Past this point a stray socket error must not become an unhandled event.
  server.on("error", (error) => {
    console.error("[pglite-server]", error.message);
  });

  const boundPort = server.address().port;

  return {
    port: boundPort,
    url: `postgres://postgres:postgres@${host}:${boundPort}/postgres`,
    db,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--port") {
      args.port = Number(argv[++i]);
    } else if (key === "--data-dir") {
      args.dataDir = argv[++i];
    } else if (key === "--host") {
      args.host = argv[++i];
    }
  }
  return args;
}

// CLI mode: `node pglite-server.mjs --port 5433 [--data-dir ./pgdata]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startPgliteServer(parseArgs(process.argv.slice(2)));
  console.log(`pglite-postgres listening on ${server.url}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
