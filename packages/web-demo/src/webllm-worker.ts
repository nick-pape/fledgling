import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (message: MessageEvent): void => {
  handler.onmessage(message);
};
