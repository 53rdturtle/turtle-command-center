import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

/**
 * Opens the OS's native folder picker on the machine running the server.
 * Only meaningful while the server runs locally; resolves null if the user cancels.
 */

// The modern Windows folder dialog (IFileOpenDialog with FOS_PICKFOLDERS). The FolderBrowserDialog
// available in Windows PowerShell 5.1 is the old tree-view one.
const WINDOWS_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$dll = $env:TCC_PICKER_DLL
if (Test-Path $dll) { Add-Type -Path $dll } else {
Add-Type -OutputAssembly $dll -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TccFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);

  // Windows won't let a background process take focus from the user's window (the browser).
  // Briefly sharing the foreground thread's input state is the standard way to be allowed to.
  public static void ForceForeground(IntPtr hWnd) {
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint thisThread = GetCurrentThreadId();
    bool attached = fgThread != thisThread && AttachThreadInput(thisThread, fgThread, true);
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(thisThread, fgThread, false);
    }
  }

  public static string Pick(IntPtr owner, string title) {
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    dialog.SetOptions(0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    dialog.SetTitle(title);
    if (dialog.Show(owner) != 0) return null; // cancelled
    IShellItem item;
    dialog.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
"@
Add-Type -Path $dll
}
# An invisible, topmost, focused owner window: the dialog inherits being on top and in the foreground,
# and centers on screen with it.
$owner = New-Object System.Windows.Forms.Form -Property @{
  TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; Opacity = 0
  StartPosition = 'CenterScreen'; Size = New-Object System.Drawing.Size(1, 1)
}
$owner.Show()
[TccFolderPicker]::ForceForeground($owner.Handle)
$path = [TccFolderPicker]::Pick($owner.Handle, 'Select the project repo folder')
$owner.Dispose()
if ($path) { [Console]::Out.Write($path) }
`;

/** Cancelling exits 0 with no output on Windows, but exits 1 on macOS (osascript) and Linux (zenity). */
function run(cmd: string, args: string[], cancelExitCode?: number) {
  return new Promise<string | null>((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', env: { ...process.env, TCC_PICKER_DLL: join(DATA_DIR, 'folder-picker-v2.dll') } }, (err, stdout, stderr) => {
      const path = stdout.trim();
      if (path) return resolve(path);
      if (err && (err as { code?: number }).code === cancelExitCode) return resolve(null);
      // PowerShell serializes progress records to stderr as CLIXML when it isn't attached to a console.
      const errText = stderr.startsWith('#< CLIXML') ? '' : stderr.trim();
      if (err || errText) return reject(new Error(`Folder picker failed: ${errText || err?.message}`));
      resolve(null);
    });
  });
}

let open = false;

export async function pickFolder(): Promise<string | null> {
  if (open) throw new Error('A folder picker is already open (check your taskbar)');
  open = true;
  try {
    switch (process.platform) {
      case 'win32':
        return await run('powershell.exe', [
          '-NoProfile', '-STA', '-NonInteractive',
          '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
        ]);
      case 'darwin':
        return (await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select the project repo folder")'], 1))
          ?.replace(/\/$/, '') ?? null;
      default:
        return await run('zenity', ['--file-selection', '--directory', '--title=Select the project repo folder'], 1);
    }
  } finally {
    open = false;
  }
}
