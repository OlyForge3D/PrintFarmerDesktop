import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ArtifactIdentity } from './updateState.js';

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;

export interface WindowsInstallerSynchronization {
  afterVerification: () => void | Promise<void>;
}

interface LaunchVerifiedWindowsInstallerOptions {
  spawnImplementation?: typeof spawn;
  powershellPath?: string;
  synchronization?: WindowsInstallerSynchronization;
}

function encodedUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeExpression(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUtf8(value)}'))`;
}

export function buildVerifiedInstallerScript(
  installerPath: string,
  artifact: ArtifactIdentity,
  synchronizeAfterVerification = false,
): string {
  const synchronizationScript = synchronizeAfterVerification
    ? `
[Console]::Out.WriteLine('VERIFIED')
if ([Console]::In.ReadLine() -ne 'CONTINUE') {
  throw 'installer race-test continuation was not received'
}`
    : '';
  return `
$ErrorActionPreference = 'Stop'
$installerPath = ${decodeExpression(installerPath)}
$expectedSha256 = '${artifact.sha256}'
$expectedSize = [Int64]${artifact.size}
$stream = $null
try {
  $stream = [IO.FileStream]::new(
    $installerPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  if ($stream.Length -ne $expectedSize) {
    throw "installer size mismatch: expected $expectedSize, received $($stream.Length)"
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $actualSha256 = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  if ($actualSha256 -ne $expectedSha256) {
    throw "installer digest mismatch: expected $expectedSha256, received $actualSha256"
  }
  ${synchronizationScript}
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $installerPath
  $startInfo.Arguments = '--silent'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($installerPath)
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    throw 'Process.Start returned no installer process'
  }
  [Console]::Out.WriteLine("STARTED:$($process.Id)")
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $stream) {
    $stream.Dispose()
  }
}
`;
}

function minimalWindowsEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const name of [
    'ComSpec',
    'Path',
    'PATHEXT',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ]) {
    if (environment[name] !== undefined) {
      isolated[name] = environment[name];
    }
  }
  return isolated;
}

function collectOutput(
  stream: NodeJS.ReadableStream | null,
  label: string,
  marker?: string,
): { output: Promise<string>; marker?: Promise<void> } {
  if (!stream) return { output: Promise.resolve('') };
  let markerResolved = false;
  let resolveMarker: (() => void) | undefined;
  let rejectMarker: ((error: Error) => void) | undefined;
  const markerPromise = marker
    ? new Promise<void>((resolve, reject) => {
        resolveMarker = resolve;
        rejectMarker = reject;
      })
    : undefined;
  const output = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > MAX_HELPER_OUTPUT_BYTES) {
        const failure = new Error(
          `${label} exceeded ${MAX_HELPER_OUTPUT_BYTES} bytes`,
        );
        reject(failure);
        rejectMarker?.(failure);
        return;
      }
      chunks.push(bytes);
      if (
        marker &&
        !markerResolved &&
        Buffer.concat(chunks).toString('utf8').includes(marker)
      ) {
        markerResolved = true;
        resolveMarker?.();
      }
    });
    stream.once('error', (error) => {
      const failure =
        error instanceof Error
          ? error
          : new Error(`${label} failed with a non-Error value`);
      reject(failure);
      rejectMarker?.(failure);
    });
    stream.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
      if (marker && !markerResolved) {
        rejectMarker?.(
          new Error(`verified installer helper exited before ${marker}`),
        );
      }
    });
  });
  return markerPromise ? { output, marker: markerPromise } : { output };
}

export async function launchVerifiedWindowsInstaller(
  installerPath: string,
  artifact: ArtifactIdentity,
  options: LaunchVerifiedWindowsInstallerOptions = {},
): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershellPath =
    options.powershellPath ??
    path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  const encodedCommand = Buffer.from(
    buildVerifiedInstallerScript(
      installerPath,
      artifact,
      options.synchronization !== undefined,
    ),
    'utf16le',
  ).toString('base64');
  const spawnImplementation = options.spawnImplementation ?? spawn;
  const child = spawnImplementation(
    powershellPath,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand,
    ],
    {
      env: minimalWindowsEnvironment(process.env),
      stdio: [options.synchronization ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const stdout = collectOutput(
    child.stdout,
    'installer helper stdout',
    options.synchronization ? 'VERIFIED' : undefined,
  );
  const stderr = collectOutput(child.stderr, 'installer helper stderr');
  const exitCodePromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`verified installer helper terminated by ${signal}`));
      } else {
        resolve(code ?? -1);
      }
    });
  });
  if (options.synchronization) {
    try {
      await stdout.marker;
      await options.synchronization.afterVerification();
      child.stdin?.end('CONTINUE\n');
    } catch (error) {
      child.stdin?.destroy();
      child.kill();
      await Promise.allSettled([exitCodePromise, stdout.output, stderr.output]);
      throw error;
    }
  }
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    exitCodePromise,
    stdout.output,
    stderr.output,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `verified installer helper failed with code ${exitCode}: ${stderrText.trim() || stdoutText.trim() || 'no diagnostic'}`,
    );
  }
  if (!/^STARTED:\d+\s*$/m.test(stdoutText)) {
    throw new Error(
      `verified installer helper did not confirm child creation: ${stdoutText.trim() || 'no output'}`,
    );
  }
}
