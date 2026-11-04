using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// A console executable avoids CMD's second expansion of PowerShell arguments (%VAR%, &, |, etc.).
internal static class VonvonCli {
  private static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
      result.Append('\\', slashes).Append(c);
      slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }

  public static int Main(string[] args) {
    try {
      string bin = AppDomain.CurrentDomain.BaseDirectory;
      string executable = Path.GetFullPath(Path.Combine(bin, "..", "..", "Vonvon Bot.exe"));
      string cli = Path.GetFullPath(Path.Combine(bin, "..", "daemon", "bin", "vonvon.mjs"));
      if (!File.Exists(executable) || !File.Exists(cli)) throw new FileNotFoundException("Vonvon Bot installation is incomplete. Reinstall the desktop app.");
      var arguments = new StringBuilder(Quote(cli));
      foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
      var start = new ProcessStartInfo(executable, arguments.ToString());
      start.UseShellExecute = false;
      start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
      // Both processes receive Ctrl+C. Let the child handle it and report its exit code before we leave.
      Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
      using (var child = Process.Start(start)) {
        if (child == null) throw new IOException("Could not start the bundled Vonvon Bot command.");
        child.WaitForExit();
        return child.ExitCode;
      }
    } catch (Exception error) {
      Console.Error.WriteLine("vonvon: " + error.Message);
      return 1;
    }
  }
}
