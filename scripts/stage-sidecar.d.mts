export const SIDECAR_BUILD_ARGS: readonly [
  'build',
  '--locked',
  '--release',
  '-p',
  'model-core',
  '--features',
  'sqlite',
];
