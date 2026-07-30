export interface GenerateUpdateMetadataOptions {
  artifactsDirectory: string;
  version: string;
  tag: string;
  repository: string;
  publishedAt: string;
  environment?: NodeJS.ProcessEnv;
}

export const UPDATE_METADATA_SCHEMA_VERSION: 1;
export function createSignedUpdateMetadata(
  options: GenerateUpdateMetadataOptions,
): { payload: string; signature: string };
