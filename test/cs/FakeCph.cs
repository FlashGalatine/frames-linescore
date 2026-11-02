// A stand-in for Streamer.bot's CPH, just enough for the two Linescore actions.
// verify-cs.mjs compiles the real action files against this with csc.exe.
using System;
using System.Collections.Generic;
using System.Globalization;

public class FakeCph
{
    public Dictionary<string, object> Globals = new Dictionary<string, object>();
    public Dictionary<string, string> Args = new Dictionary<string, string>();
    public string LastBroadcast;
    public int Broadcasts;
    public int Warns;
    public bool ThrowOnGet;
    public bool ThrowOnNextBroadcast;

    public bool TryGetArg<T>(string key, out T value)
    {
        string v;
        if (Args.TryGetValue(key, out v)) { value = (T)(object)v; return true; }
        value = default(T);
        return false;
    }

    public T GetGlobalVar<T>(string key, bool persisted)
    {
        if (ThrowOnGet) throw new InvalidOperationException("forced failure");
        object v;
        // A cast, as a stored number read as a string may well fail in Streamer.bot.
        if (Globals.TryGetValue(key, out v)) return (T)v;
        return default(T);
    }

    public void SetGlobalVar(string key, object value, bool persisted)
    {
        Globals[key] = Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    public bool RunAction(string name)
    {
        if (name != "Linescore Push") throw new InvalidOperationException("unexpected action: " + name);
        return new Push.CPHInline().Execute();
    }

    public void WebsocketBroadcastJson(string json)
    {
        if (ThrowOnNextBroadcast) { ThrowOnNextBroadcast = false; throw new InvalidOperationException("forced failure"); }
        LastBroadcast = json;
        Broadcasts++;
    }
    public void LogInfo(string message) { }
    public void LogWarn(string message) { Warns++; }
}

public static class World
{
    public static FakeCph Cph = new FakeCph();
}

// Streamer.bot gives CPHInline its CPH member; here each namespace's partial class does.
namespace Command { public partial class CPHInline { public FakeCph CPH { get { return World.Cph; } } } }
namespace Push { public partial class CPHInline { public FakeCph CPH { get { return World.Cph; } } } }
