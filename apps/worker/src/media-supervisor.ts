import { spawn, type ChildProcess } from "node:child_process";

const argumentsList = process.argv.slice(2);
const separator = argumentsList.indexOf("--");
if (separator < 0) {
  process.stderr.write("media-supervisor: missing -- command separator\n");
  process.exit(64);
}
const options = argumentsList.slice(0, separator);
const command = argumentsList[separator + 1];
const commandArguments = argumentsList.slice(separator + 2);
if (command === undefined) {
  process.stderr.write("media-supervisor: missing command\n");
  process.exit(64);
}
const parentPidIndex = options.indexOf("--parent-pid");
const expectedParentPid =
  parentPidIndex >= 0 && options[parentPidIndex + 1] !== undefined
    ? Number(options[parentPidIndex + 1])
    : process.ppid;
if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 0) {
  process.stderr.write("media-supervisor: invalid parent pid\n");
  process.exit(64);
}

const child: ChildProcess = spawn(command, commandArguments, {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let terminating = false;

child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

child.on("error", (error) => {
  process.stderr.write(`media-supervisor: ${error.message}\n`);
  process.exit(70);
});

child.on("exit", (code, signal) => {
  if (signal !== null) process.exit(128);
  process.exit(code ?? 0);
});

const monitor = setInterval(() => {
  if (parentAlive()) return;
  terminateChild();
}, 100);
monitor.unref();

process.on("SIGTERM", () => terminateChild());
process.on("SIGINT", () => terminateChild());
process.on("SIGHUP", () => terminateChild());

function parentAlive(): boolean {
  if (process.ppid !== expectedParentPid) return false;
  try {
    process.kill(expectedParentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateChild(): void {
  if (terminating) return;
  terminating = true;
  clearInterval(monitor);
  if (child.pid === undefined) {
    process.exit(143);
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
  setTimeout(() => process.exit(143), 250).unref();
}
