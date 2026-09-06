# Runs one command inside a Windows Job Object with "kill on job close": every descendant of the command,
# however deep and however detached, dies when the command ends (or when this wrapper dies). The command is
# created SUSPENDED, assigned to the job, then resumed, so no child can escape before the assignment.
# Standard handles are passed through, so stdin/stdout/stderr of the caller reach the command unchanged.
# The command line comes from a JSON file (an array: command, args...), never from PowerShell's own argument
# parser, which rejects arguments such as a bare "-" and reinterprets others.
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File win-job-run.ps1 <cmdFile.json>
# Exit code: the command's exit code; 64 for a usage error; 66 when the job could not be set up.
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 1 -or -not (Test-Path -LiteralPath $args[0])) {
  [Console]::Error.WriteLine('usage: win-job-run.ps1 <cmdFile.json>')
  exit 64
}
# ConvertFrom-Json emits the JSON array as ONE object on the pipeline; enumerate it into plain strings.
$parsed = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8 | ConvertFrom-Json
$argv = @($parsed | ForEach-Object { [string]$_ })
if ($argv.Count -lt 1) {
  [Console]::Error.WriteLine('win-job-run.ps1: the command file holds no command')
  exit 64
}

# Quotes one argument the way CommandLineToArgvW expects it (the rules every C runtime follows).
function Quote-Arg([string]$a) {
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $s = '"'
  $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq '\') { $bs++ }
    elseif ($ch -eq '"') { $s += ('\' * ($bs * 2 + 1)) + '"'; $bs = 0 }
    else { $s += ('\' * $bs) + $ch; $bs = 0 }
  }
  $s += ('\' * ($bs * 2)) + '"'
  return $s
}

$commandLine = ($argv | ForEach-Object { Quote-Arg $_ }) -join ' '
if ($env:TANDEM_JOB_DEBUG -eq '1') { [Console]::Error.WriteLine("tandem-job-cmdline: $commandLine") }

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TandemJobRun
{
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint INFINITE = 0xFFFFFFFF;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    public static int Run(string commandLine)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)))
            throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        var buffer = new StringBuilder(commandLine);
        if (!CreateProcess(null, buffer, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi))
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(pi.hProcess, 1); // never let an unconfined process run
            throw new Exception("AssignProcessToJobObject failed: " + error);
        }
        ResumeThread(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
        TerminateJobObject(job, 1); // survivors die now, not only when the handle closes
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        return unchecked((int)code);
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  $code = [TandemJobRun]::Run($commandLine)
  exit $code
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException } # the .NET exception, not PowerShell's invocation wrapper
  [Console]::Error.WriteLine("tandem-job-error: $($e.Message)")
  exit 66
}
