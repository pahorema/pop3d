import { buildModel, type ModelJob, type ModelReply } from "./model-build";

declare const self: {
  onmessage: ((event: MessageEvent<ModelJob>) => void) | null;
  postMessage(message: ModelReply, transfer?: Transferable[]): void;
};

// Runs the CPU-heavy model builds off the server's main thread.
self.onmessage = (event: MessageEvent<ModelJob>) => {
  const job = event.data;
  let reply: ModelReply;
  try {
    reply = { id: job.id, ok: true, ...buildModel(job) };
  } catch (error) {
    console.error("[model] build failed:", error);
    reply = { id: job.id, ok: false, message: (error as Error).message || "build failed" };
  }
  self.postMessage(reply, reply.ok ? [reply.body.buffer] : []);
};
