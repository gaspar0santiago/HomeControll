Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class ScreenOn {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int flags, int dx, int dy, int cClicks, int cExtra);
    public static void Run() { mouse_event(1, 1, 0, 0, 0); mouse_event(1, -1, 0, 0, 0); }
}
'
[ScreenOn]::Run()