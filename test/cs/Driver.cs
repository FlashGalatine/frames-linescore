// Reads tab-separated commands on stdin, runs the real actions, prints the results.
// Every text field is base64 UTF-8, so tabs, newlines and emoji survive the pipe.
//   RESET                     a new, empty world
//   SEED  key  value          sets a global variable
//   SEEDINT key value         sets a global variable to a number, not a string
//   THROW 1|0                 makes GetGlobalVar throw (or stop throwing)
//   FAILBROADCAST             makes the next broadcast throw
//   PUSH                      runs Linescore Push
//   RUN   name:value ...       runs Linescore Command with those args
// After PUSH and RUN it prints: P  <payload>  <warn count>  <Execute's result>
using System;
using System.Text;

public static class Driver
{
    static string Unb64(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }
    static string B64(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? "")); }

    public static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] f = line.Split('\t');
            FakeCph cph = World.Cph;
            switch (f[0])
            {
                case "RESET": World.Cph = new FakeCph(); break;
                case "SEED": cph.Globals[Unb64(f[1])] = Unb64(f[2]); break;
                case "SEEDINT": cph.Globals[Unb64(f[1])] = int.Parse(Unb64(f[2])); break;
                case "THROW": cph.ThrowOnGet = f[1] == "1"; break;
                case "FAILBROADCAST": cph.ThrowOnNextBroadcast = true; break;
                case "PUSH":
                {
                    cph.Warns = 0;
                    cph.Broadcasts = 0;
                    bool ok = new Push.CPHInline().Execute();
                    Console.WriteLine("P\t" + B64(cph.LastBroadcast) + "\t" + cph.Warns + "\t" + ok + "\t" + cph.Broadcasts);
                    break;
                }
                case "RUN":
                {
                    cph.Args.Clear();
                    for (int i = 1; i < f.Length; i++)
                    {
                        string[] kv = f[i].Split(':');
                        cph.Args[Unb64(kv[0])] = Unb64(kv[1]);
                    }
                    cph.Warns = 0;
                    bool ok = new Command.CPHInline().Execute();
                    int warns = cph.Warns;
                    // Always fetch the state afterwards, so a rejected command still has a payload.
                    new Push.CPHInline().Execute();
                    Console.WriteLine("P\t" + B64(cph.LastBroadcast) + "\t" + warns + "\t" + ok);
                    break;
                }
                default: throw new InvalidOperationException("bad driver line: " + f[0]);
            }
        }
        return 0;
    }
}
