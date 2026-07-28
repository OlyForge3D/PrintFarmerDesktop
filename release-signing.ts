import path from 'node:path';

export const RELEASE_SIGNING_FLAG = 'PRINTFARMER_REQUIRE_SIGNING';
export const UPDATE_PUBLIC_KEY_ENV = 'PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64';

export interface ReleaseSigningConfiguration {
  packagerConfig: Record<string, unknown>;
  squirrelConfig: Record<string, unknown>;
}

export const WINDOWS_TIMESTAMP_SERVER = 'http://timestamp.digicert.com';

function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform,
): Record<string, string> {
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `release signing is required for ${platform}, but these environment variables are missing: ${missing.join(', ')}`,
    );
  }

  return Object.fromEntries(
    names.map((name) => [name, environment[name]!.trim()]),
  );
}

export function resolveReleaseSigningConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ReleaseSigningConfiguration {
  if (environment[RELEASE_SIGNING_FLAG] !== '1') {
    return { packagerConfig: {}, squirrelConfig: {} };
  }

  if (platform === 'win32') {
    const values = requireEnvironment(
      environment,
      [
        'WINDOWS_CERTIFICATE_FILE',
        'WINDOWS_CERTIFICATE_PASSWORD',
        UPDATE_PUBLIC_KEY_ENV,
      ],
      platform,
    );
    const certificateFile = path.resolve(values.WINDOWS_CERTIFICATE_FILE!);
    const certificatePassword = values.WINDOWS_CERTIFICATE_PASSWORD!;
    const windowsSign = {
      certificateFile,
      certificatePassword,
      hashes: ['sha256'],
      timestampServer: WINDOWS_TIMESTAMP_SERVER,
    };

    return {
      packagerConfig: {
        windowsSign,
      },
      squirrelConfig: {
        windowsSign,
      },
    };
  }

  if (platform === 'darwin') {
    const values = requireEnvironment(
      environment,
      [
        'APPLE_SIGNING_IDENTITY',
        'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_TEAM_ID',
        'APPLE_SIGNING_KEYCHAIN',
        UPDATE_PUBLIC_KEY_ENV,
      ],
      platform,
    );

    return {
      packagerConfig: {
        osxSign: {
          identity: values.APPLE_SIGNING_IDENTITY,
          keychain: values.APPLE_SIGNING_KEYCHAIN,
          hardenedRuntime: true,
        },
        osxNotarize: {
          appleId: values.APPLE_ID,
          appleIdPassword: values.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: values.APPLE_TEAM_ID,
        },
      },
      squirrelConfig: {},
    };
  }

  throw new Error(
    `release signing is required, but platform ${platform} has no signing configuration`,
  );
}
