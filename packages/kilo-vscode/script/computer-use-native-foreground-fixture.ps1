$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class RayaForegroundFixture {
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  private static Form first;
  private static Form second;

  private static bool Focus(Form form) {
    form.Show();
    form.Activate();
    SetForegroundWindow(form.Handle);
    return GetForegroundWindow() == form.Handle;
  }

  public static void Run() {
    first = new Form { Text = "Raya capture fixture A", Width = 640, Height = 480 };
    second = new Form { Text = "Raya capture fixture B", Width = 640, Height = 480 };
    first.Shown += (sender, args) => {
      if (!Focus(first)) {
        Console.WriteLine("UNAVAILABLE");
        first.Close();
        return;
      }
      Console.WriteLine("READY");
      var input = new Thread(() => {
        string command;
        while ((command = Console.ReadLine()) != null) {
          var next = command;
          try {
            first.BeginInvoke((Action)(() => {
              if (next == "quit") { first.Close(); return; }
              if (next == "to-b") {
                Console.WriteLine(Focus(second) ? "B" : "UNAVAILABLE");
                return;
              }
              if (next == "to-a") {
                Console.WriteLine(Focus(first) ? "A" : "UNAVAILABLE");
                return;
              }
              if (next == "resize") {
                first.Width += 80;
                first.Height += 40;
                Console.WriteLine("RESIZED");
                return;
              }
              if (next != "flash") return;
              var away = Focus(second);
              Thread.Sleep(5);
              var back = Focus(first);
              Console.WriteLine(away && back ? "FLASHED" : "UNAVAILABLE");
            }));
          } catch (InvalidOperationException) { return; }
        }
      });
      input.IsBackground = true;
      input.Start();
    };
    Application.Run(first);
    second.Dispose();
  }
}
'@ -ReferencedAssemblies System.Windows.Forms
[RayaForegroundFixture]::Run()
