import type { WebviewToHostMessage } from '../src/webview/protocol.js';

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** `acquireVsCodeApi` may be called only once per webview load. */
export const vscodeApi = acquireVsCodeApi();
