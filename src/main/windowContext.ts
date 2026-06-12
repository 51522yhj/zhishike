import { execFile } from "node:child_process";

const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Window {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$handle = [Win32Window]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][Win32Window]::GetWindowText($handle, $builder, $builder.Capacity)
$builder.ToString()
`;

export async function getActiveWindowTitle() {
  if (process.platform !== "win32") {
    return "";
  }

  return new Promise<string>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(stdout.trim());
    });
  });
}
