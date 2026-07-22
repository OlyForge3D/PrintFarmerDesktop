import type { PrintFarmerApi } from '@shared/ipc';

declare global {
  interface Window {
    readonly printFarmer: PrintFarmerApi;
  }
}

export {};
