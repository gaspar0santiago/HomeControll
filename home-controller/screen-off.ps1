Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class ScreenOff {
    [DllImport("user32.dll")]
    public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
    public static void Run() { SendMessage(-1, 0x0112, 0xF170, 2); }
}
'
[ScreenOff]::Run()