import type {
  BuildParams,
  BuildStage,
  DioramaData,
  PrintParams,
  PrintPart,
  WorkerRequest,
  WorkerResponse,
} from "./types";

declare const __WORKER_URL__: string;

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
  progress?: (stage: BuildStage, ratio: number) => void;
}

/** Talks to the geometry worker: one promise per request, stale builds are dropped. */
export class Engine {
  private worker = new Worker(__WORKER_URL__);
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private currentBuild = 0;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) {
        request.reject(new EngineError("internal", event.message || "Worker crashed"));
      }
      this.pending.clear();
    };
  }

  private receive(message: WorkerResponse): void {
    const request = this.pending.get(message.id);
    if (!request) return;
    switch (message.type) {
      case "progress":
        request.progress?.(message.stage, message.ratio);
        return;
      case "built":
        request.resolve(message.data);
        break;
      case "printed":
        request.resolve({ parts: message.parts, scale: message.scale });
        break;
      case "error":
        request.reject(new EngineError(message.code, message.message));
        break;
    }
    this.pending.delete(message.id);
  }

  private send<T>(message: WorkerRequest, progress?: Pending["progress"]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject, progress });
      this.worker.postMessage(message);
    });
  }

  /**
   * Builds a diorama. Starting a new build abandons the previous one, whose promise rejects
   * with the code `superseded`.
   */
  build(params: BuildParams, progress?: (stage: BuildStage, ratio: number) => void): Promise<DioramaData> {
    const previous = this.pending.get(this.currentBuild);
    if (previous) {
      this.pending.delete(this.currentBuild);
      previous.reject(new EngineError("superseded", "Replaced by a newer request"));
    }
    const id = this.nextId++;
    this.currentBuild = id;
    return this.send<DioramaData>({ type: "build", id, params }, progress);
  }

  /** Rebuilds the latest diorama as printable solids. */
  print(params: PrintParams): Promise<{ parts: PrintPart[]; scale: number }> {
    return this.send({ type: "print", id: this.nextId++, params });
  }
}
