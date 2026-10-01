import type { EventKitApi } from '../common/ipc';

declare global {
  interface Window {
    eventkit: EventKitApi;
  }
}

export {};
