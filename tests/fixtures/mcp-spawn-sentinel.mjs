// A SPAWN SENTINEL, not an MCP server.
//
// It exists to answer one question with a fact on disk: was this process
// STARTED? Asserting "the command threw" cannot answer it - a spawn followed
// by an error looks identical to a refusal from the caller's side, which is the
// disjunction shape (`caught !== null || stderr.includes(...)`) whose left arm
// is satisfied by the defect itself. So the proof is a file that only a running
// process can create.
//
// The sentinel path arrives as argv[2], never through the environment: MCP
// children are started with buildMinimalEnv(), which forwards only PATH/HOME
// and explicitly declared vars, so an env-carried path would silently vanish
// and the sentinel would read as "never spawned" for the wrong reason.
import { appendFileSync } from 'node:fs';

const sentinel = process.argv[2];
if (sentinel) appendFileSync(sentinel, `SPAWNED pid=${process.pid} cwd=${process.cwd()}\n`);

// Speak no MCP: the handshake is irrelevant here and a silent child would make
// every caller wait out its timeout. Exiting immediately keeps the untrusted
// arm fast and makes the trusted control fail on CONNECT rather than on time.
process.exit(0);
