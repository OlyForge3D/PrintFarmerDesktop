import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ArtifactIdentity } from './updateState.js';

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 30_000;

export interface WindowsInstallerSynchronization {
  afterVerification: () => void | Promise<void>;
}

interface LaunchVerifiedWindowsInstallerOptions {
  spawnImplementation?: typeof spawn;
  powershellPath?: string;
  synchronization?: WindowsInstallerSynchronization;
  helperTimeoutMs?: number;
  onStarted?: (processId: number) => void;
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
  function New-NativeDelegateType([Type[]]$parameterTypes, [Type]$returnType) {
    $assemblyName = [Reflection.AssemblyName]::new(
      'PrintFarmerNativeDelegates'
    )
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
      $assemblyName,
      [Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $module = $assembly.DefineDynamicModule('InMemoryModule', $false)
    $type = $module.DefineType(
      'GetFinalPathNameByHandleDelegate',
      [Reflection.TypeAttributes]'Class, Public, Sealed, AnsiClass, AutoClass',
      [MulticastDelegate]
    )
    $attributeConstructor = (
      [Runtime.InteropServices.UnmanagedFunctionPointerAttribute].GetConstructor(
        [Type[]]@([Runtime.InteropServices.CallingConvention])
      )
    )
    $attribute = [Reflection.Emit.CustomAttributeBuilder]::new(
      $attributeConstructor,
      [object[]]@([Runtime.InteropServices.CallingConvention]::Winapi),
      [Reflection.FieldInfo[]]@(
        [Runtime.InteropServices.UnmanagedFunctionPointerAttribute].GetField(
          'CharSet'
        ),
        [Runtime.InteropServices.UnmanagedFunctionPointerAttribute].GetField(
          'SetLastError'
        )
      ),
      [object[]]@([Runtime.InteropServices.CharSet]::Unicode, $true)
    )
    $type.SetCustomAttribute($attribute)
    $constructor = $type.DefineConstructor(
      [Reflection.MethodAttributes]'RTSpecialName, HideBySig, Public',
      [Reflection.CallingConventions]::Standard,
      $parameterTypes
    )
    $constructor.SetImplementationFlags(
      [Reflection.MethodImplAttributes]'Runtime, Managed'
    )
    $invoke = $type.DefineMethod(
      'Invoke',
      [Reflection.MethodAttributes]'Public, HideBySig, NewSlot, Virtual',
      $returnType,
      $parameterTypes
    )
    $invoke.SetImplementationFlags(
      [Reflection.MethodImplAttributes]'Runtime, Managed'
    )
    return $type.CreateType()
  }
  $unsafeNativeMethods = [Uri].Assembly.GetType(
    'Microsoft.Win32.UnsafeNativeMethods',
    $true
  )
  $bindingFlags = [Reflection.BindingFlags]'Static, Public, NonPublic'
  $getModuleHandle = $unsafeNativeMethods.GetMethod(
    'GetModuleHandle',
    $bindingFlags,
    $null,
    [Type[]]@([string]),
    $null
  )
  $getProcAddress = $unsafeNativeMethods.GetMethod(
    'GetProcAddress',
    $bindingFlags,
    $null,
    [Type[]]@([IntPtr], [string]),
    $null
  )
  if ($null -eq $getModuleHandle -or $null -eq $getProcAddress) {
    throw 'required Windows native loader methods are unavailable'
  }
  $kernel32 = $getModuleHandle.Invoke($null, @('kernel32.dll'))
  $functionPointer = $getProcAddress.Invoke(
    $null,
    @($kernel32, 'GetFinalPathNameByHandleW')
  )
  if ($functionPointer -eq [IntPtr]::Zero) {
    throw 'GetFinalPathNameByHandleW is unavailable'
  }
  $delegateType = New-NativeDelegateType (
    [Type[]]@([IntPtr], [Text.StringBuilder], [UInt32], [UInt32])
  ) ([UInt32])
  $getFinalPath = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer(
    $functionPointer,
    $delegateType
  )
  [uint32]$capacity = 512
  while ($true) {
    $pathBuffer = [Text.StringBuilder]::new([int]$capacity)
    [uint32]$length = $getFinalPath.Invoke(
      $stream.SafeFileHandle.DangerousGetHandle(),
      $pathBuffer,
      $capacity,
      [uint32]0
    )
    if ($length -eq 0) {
      $win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [ComponentModel.Win32Exception]::new($win32Error)
    }
    if ($length -lt $capacity) {
      $canonicalPath = $pathBuffer.ToString()
      break
    }
    if ($length -ge 32767) {
      throw 'canonical installer path exceeds the Windows path limit'
    }
    $capacity = [uint32]($length + 1)
  }
  if ($canonicalPath.StartsWith('\\\\?\\UNC\\', [StringComparison]::OrdinalIgnoreCase)) {
    $canonicalPath = '\\\\' + $canonicalPath.Substring(8)
  } elseif ($canonicalPath.StartsWith('\\\\?\\', [StringComparison]::OrdinalIgnoreCase)) {
    $canonicalPath = $canonicalPath.Substring(4)
  }
  $isDrivePath = (
    $canonicalPath.Length -ge 3 -and
    [char]::IsLetter($canonicalPath[0]) -and
    $canonicalPath[1] -eq ':' -and
    $canonicalPath[2] -eq [IO.Path]::DirectorySeparatorChar
  )
  $firstUncSeparator = $canonicalPath.IndexOf(
    [IO.Path]::DirectorySeparatorChar,
    2
  )
  $secondUncSeparator = if ($firstUncSeparator -gt 2) {
    $canonicalPath.IndexOf(
      [IO.Path]::DirectorySeparatorChar,
      $firstUncSeparator + 1
    )
  } else {
    -1
  }
  $isUncPath = (
    $canonicalPath.StartsWith('\\\\') -and
    $firstUncSeparator -gt 2 -and
    $secondUncSeparator -gt ($firstUncSeparator + 1)
  )
  if (
    $canonicalPath.IndexOf([char]0) -ge 0 -or
    (-not $isDrivePath -and -not $isUncPath)
  ) {
    throw "canonical installer path is not a usable local or UNC path: $canonicalPath"
  }
  ${synchronizationScript}
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $canonicalPath
  $startInfo.Arguments = '--silent'
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($canonicalPath)
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
  const timeoutMs = options.helperTimeoutMs ?? HELPER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('verified installer helper timeout must be positive');
  }
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
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(`verified installer helper timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });
  const withinDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, timeoutPromise]);
  try {
    if (options.synchronization) {
      await withinDeadline(
        stdout.marker ??
          Promise.reject(new Error('missing verification marker')),
      );
      await withinDeadline(
        Promise.resolve(options.synchronization.afterVerification()),
      );
      child.stdin?.end('CONTINUE\n');
    }
    const [exitCode, stdoutText, stderrText] = await withinDeadline(
      Promise.all([exitCodePromise, stdout.output, stderr.output]),
    );
    if (exitCode !== 0) {
      throw new Error(
        `verified installer helper failed with code ${exitCode}: ${stderrText.trim() || stdoutText.trim() || 'no diagnostic'}`,
      );
    }
    const lines = stdoutText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const startedIndex = options.synchronization ? 1 : 0;
    if (
      lines.length !== startedIndex + 1 ||
      (options.synchronization && lines[0] !== 'VERIFIED') ||
      !/^STARTED:\d+$/.test(lines[startedIndex] ?? '')
    ) {
      throw new Error(
        `verified installer helper returned an invalid protocol transcript: ${stdoutText.trim() || 'no output'}`,
      );
    }
    const processId = Number(
      (lines[startedIndex] ?? '').slice('STARTED:'.length),
    );
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new Error(
        'verified installer helper returned an invalid process id',
      );
    }
    options.onStarted?.(processId);
  } catch (error) {
    child.stdin?.destroy();
    child.kill();
    await Promise.allSettled([exitCodePromise, stdout.output, stderr.output]);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
