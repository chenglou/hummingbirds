import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalStringify, readJson } from "./json.ts";
import { RunStore } from "./store.ts";

const args = process.argv.slice(2);
const command = args[0];

try {
  switch (command) {
    case "init": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      const promptPath = resolve(requiredArg(args, 3, "worker prompt file"));
      const executionPath = resolve(
        requiredArg(args, 4, "worker execution file"),
      );
      print(
        store.initialize(requiredArg(args, 2, "run id"), {
          instructions: readFileSync(promptPath, "utf8"),
          execution: readJson(executionPath),
        }),
      );
      break;
    }
    case "add-node": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      print(store.addNodeFromFile(resolve(requiredArg(args, 2, "node file"))));
      break;
    }
    case "enqueue": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      const to = requiredArg(args, 2, "destination node");
      const body = readJson(resolve(requiredArg(args, 3, "body file")));
      const callerId = args[4] ?? null;
      const requestId = args[5];
      print(store.enqueue(to, body, callerId, requestId));
      break;
    }
    case "lease": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      const envelope = store.leaseNext(requiredArg(args, 2, "worker id"));
      if (envelope === null) {
        process.stdout.write("EMPTY\n");
      } else {
        print(envelope);
      }
      break;
    }
    case "commit": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      const leaseId = requiredArg(args, 2, "lease id");
      const proposalPath = resolve(requiredArg(args, 3, "proposal file"));
      print(store.commitFromFile(leaseId, proposalPath));
      break;
    }
    case "submit": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      const leaseId = requiredArg(args, 2, "lease id");
      const responsePath = resolve(requiredArg(args, 3, "raw response file"));
      print(store.submitRaw(leaseId, responsePath));
      break;
    }
    case "reject": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      print(
        store.rejectRaw(
          requiredArg(args, 2, "lease id"),
          resolve(requiredArg(args, 3, "raw response file")),
          requiredArg(args, 4, "rejection reason"),
        ),
      );
      break;
    }
    case "fail": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      store.fail(
        requiredArg(args, 2, "lease id"),
        requiredArg(args, 3, "failure reason"),
      );
      print({ ok: true });
      break;
    }
    case "inspect": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      print(store.inspect());
      break;
    }
    case "complete": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      const status = requiredArg(args, 2, "completion status");
      if (status !== "completed" && status !== "stopped") {
        throw new Error("Completion status must be completed or stopped");
      }
      const summary = readJson(resolve(requiredArg(args, 3, "summary file")));
      print(store.complete(status, summary));
      break;
    }
    case "verify": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      store.verify();
      print({ ok: true });
      break;
    }
    case "rebuild": {
      const store = storeAt(requiredArg(args, 1, "run directory"));
      store.rebuildSnapshots();
      print({ ok: true });
      break;
    }
    default:
      throw new Error(
        "Usage: net <init|add-node|enqueue|lease|submit|reject|commit|fail|complete|inspect|verify|rebuild> ...",
      );
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function storeAt(path: string): RunStore {
  return new RunStore(resolve(path));
}

function requiredArg(argsList: string[], index: number, label: string): string {
  const value = argsList[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(
    `${canonicalStringify(value as Parameters<typeof canonicalStringify>[0])}\n`,
  );
}
