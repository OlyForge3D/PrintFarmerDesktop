import type { ForgeConfig } from '@electron-forge/shared-types';

export interface MacBundleVersionOptions {
  appVersion: string;
  buildVersion: string;
}

export function macBundleVersionOptions(
  version: string,
): MacBundleVersionOptions;
export function configureMacBundleVersions(
  config: ForgeConfig,
  platform: string,
  readVersion: () => string,
): void;

export interface MacDirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

export function macHelperAppPaths(
  appPath: string,
  readDirectory?: (directory: string) => readonly MacDirectoryEntry[],
): string[];

export function verifyMacBundleVersions(
  outputPaths: readonly string[],
  version: string,
  options?: {
    listHelpersImplementation?: (appPath: string) => string[];
    readPlistValueImplementation?: (plistPath: string, key: string) => string;
  },
): void;
