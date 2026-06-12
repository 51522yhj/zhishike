import type { ZhishikApi } from "../preload/preload";

declare global {
  interface Window {
    zhishik: ZhishikApi;
  }
}

export {};
