using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace DshBridge {
    // The handle is owned by this supervisor only. Its closure kills ALL job members,
    // including descendants whose parent has already exited. Never attach a GUI PID.
    public static class JobHost {
        const uint Suspended = 0x00000004, NoWindow = 0x08000000;
        const uint StartUseStdHandles = 0x00000100, Inherit = 1, KillOnClose = 0x00002000;
        const uint Timeout = 258;
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
            public int length; public IntPtr descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool inherit;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
            public int cb; public string reserved, desktop, title;
            public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
            public ushort show, reservedBytes; public IntPtr reservedPointer;
            public IntPtr stdin, stdout, stderr;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
            public IntPtr process, thread; public uint processId, threadId;
        }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long processTime, jobTime; public uint flags;
            public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcesses;
            public UIntPtr affinity; public uint priority, scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {
            public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits basic; public IoCounters io;
            public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attrs, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder command, IntPtr procAttrs, IntPtr threadAttrs,
            bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static void Pump(Stream source, Stream destination) {
            var buffer = new byte[8192]; int count;
            while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
                destination.Write(buffer, 0, count); destination.Flush();
            }
        }
        static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
        static string Quote(string arg) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in arg) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', 2 * slashes + 1); result.Append(c); }
                else { result.Append('\\', slashes); result.Append(c); }
                slashes = 0;
            }
            result.Append('\\', 2 * slashes); return result.Append('"').ToString();
        }

        public static int Run(string executable, string[] args) {
            IntPtr job = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
            IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
            var info = new ProcessInfo(); bool assigned = false;
            try {
                job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                var limits = new ExtendedLimits(); limits.basic.flags = KillOnClose;
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
                var attrs = new SecurityAttributes { length = Marshal.SizeOf<SecurityAttributes>(), inherit = true };
                Check(CreatePipe(out inRead, out inWrite, ref attrs, 0));
                Check(CreatePipe(out outRead, out outWrite, ref attrs, 0));
                Check(CreatePipe(out errRead, out errWrite, ref attrs, 0));
                Check(SetHandleInformation(inWrite, Inherit, 0));
                Check(SetHandleInformation(outRead, Inherit, 0));
                Check(SetHandleInformation(errRead, Inherit, 0));
                var startup = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>(), flags = StartUseStdHandles,
                    stdin = inRead, stdout = outWrite, stderr = errWrite };
                var command = new StringBuilder(Quote(executable));
                foreach (string arg in args ?? Array.Empty<string>()) command.Append(' ').Append(Quote(arg));
                // Assign while suspended: no child can escape the job before assignment.
                Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    Suspended | NoWindow, IntPtr.Zero, null, ref startup, out info));
                Check(AssignProcessToJobObject(job, info.process)); assigned = true;
                Check(ResumeThread(info.thread) != uint.MaxValue); Close(ref info.thread);
                Close(ref inRead); Close(ref outWrite); Close(ref errWrite);
                using (var childIn = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write))
                using (var childOut = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read))
                using (var childErr = new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read)) {
                    inWrite = outRead = errRead = IntPtr.Zero;
                    var input = Task.Run(() => {
                        try { Pump(Console.OpenStandardInput(), childIn); } catch (IOException) {} catch (ObjectDisposedException) {}
                        finally { childIn.Dispose(); }
                    });
                    var output = Task.Run(() => { try { Pump(childOut, Console.OpenStandardOutput()); } catch (IOException) {} catch (ObjectDisposedException) {} });
                    var error = Task.Run(() => { try { Pump(childErr, Console.OpenStandardError()); } catch (IOException) {} catch (ObjectDisposedException) {} });
                    DateTime? inputEnded = null;
                    for (;;) {
                        uint state = WaitForSingleObject(info.process, 100);
                        if (state == 0) break;
                        if (state != Timeout) throw new Win32Exception(Marshal.GetLastWin32Error());
                        if (input.IsCompleted && inputEnded == null) inputEnded = DateTime.UtcNow;
                        // EOF includes a dead bridge. Give persistence a bounded graceful window.
                        if (inputEnded != null && DateTime.UtcNow - inputEnded.Value > TimeSpan.FromSeconds(3)) {
                            Check(TerminateJobObject(job, 124));
                        }
                    }
                    uint code; Check(GetExitCodeProcess(info.process, out code));
                    // Root exit must also reap children that inherited its stdout handles.
                    Close(ref job);
                    Task.WaitAll(new[] { output, error }, 3000);
                    return unchecked((int)code);
                }
            } finally {
                if (!assigned && info.process != IntPtr.Zero) TerminateProcess(info.process, 125);
                Close(ref job); Close(ref info.thread); Close(ref info.process);
                Close(ref inRead); Close(ref inWrite); Close(ref outRead); Close(ref outWrite);
                Close(ref errRead); Close(ref errWrite);
            }
        }
    }
}
