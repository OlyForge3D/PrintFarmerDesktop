import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ArtifactIdentity } from './updateState.js';

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;

export interface WindowsInstallerSynchronization {
  readyPath: string;
  continuePath: string;
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
  synchronization?: WindowsInstallerSynchronization,
): string {
  const synchronizationScript = synchronization
    ? `
$readyPath = ${decodeExpression(synchronization.readyPath)}
$continuePath = ${decodeExpression(synchronization.continuePath)}
[IO.File]::WriteAllText($readyPath, 'ready')
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not [IO.File]::Exists($continuePath)) {
  if ([DateTime]::UtcNow -gt $deadline) {
    throw 'timed out waiting for installer race-test continuation'
  }
  Start-Sleep -Milliseconds 10
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
): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > MAX_HELPER_OUTPUT_BYTES) {
        reject(new Error(`${label} exceeded ${MAX_HELPER_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(bytes);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
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
      options.synchronization,
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const stdoutPromise = collectOutput(child.stdout, 'installer helper stdout');
  const stderrPromise = collectOutput(child.stderr, 'installer helper stderr');
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`verified installer helper terminated by ${signal}`));
      } else {
        resolve(code ?? -1);
      }
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(
      `verified installer helper failed with code ${exitCode}: ${stderr.trim() || stdout.trim() || 'no diagnostic'}`,
    );
  }
  if (!/^STARTED:\d+\s*$/m.test(stdout)) {
    throw new Error(
      `verified installer helper did not confirm child creation: ${stdout.trim() || 'no output'}`,
    );
  }
}
