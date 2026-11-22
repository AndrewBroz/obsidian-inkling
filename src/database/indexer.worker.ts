// Export a indexWorker function in @root/index-worker.ts in order to define the worker
import { indexWorker } from "index-worker";
import type { PluginSettings } from "../types";

self.onmessage = async (event: MessageEvent<{ files: string[]; settings: PluginSettings }>) => {
	self.postMessage(await indexWorker(event.data.files, event.data.settings));
};

export default class DatabaseWorker extends Worker {
	constructor(options?: WorkerOptions) {
		super("", options);
	}
}
