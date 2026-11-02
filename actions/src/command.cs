using System;
using System.Text;
using System.Globalization;
using System.Collections.Generic;

public class CPHInline
{
    const int UndoMax = 20;
    const long ChatGuardMs = 30000;

    static readonly string[] Known = {
        "t1win", "t2win", "undo", "t1", "t2", "t1+", "t1-", "t2+", "t2-", "next",
        "t1name", "t2name", "innings", "worth", "free", "extra",
        "ball", "strike", "out", "title", "collabel", "extralabel", "totallabel",
        "preset", "reset", "hide", "show", "setmany",
    };
    static readonly string[] LabelKeys = { "ball", "strike", "out" };
    static readonly string[] LabelNames = { "Ball", "Strike", "Out" };

    public bool Execute()
    {
        // 1) Token: prefer the `command` arg (chat match or Stream Deck), strip a
        //    leading prefix like '!', and take just the first word.
        string cmdArg = (Arg("command", "") ?? "").Trim();
        while (cmdArg.Length > 0 && !char.IsLetterOrDigit(cmdArg[0])) cmdArg = cmdArg.Substring(1);
        int sp = cmdArg.IndexOf(' ');
        string token = (sp >= 0 ? cmdArg.Substring(0, sp) : cmdArg).ToLowerInvariant();

        // 2) Value: explicit `value` arg wins (Stream Deck); else chat `rawInput`; else
        //    any remainder of the command text.
        string cmdRest = sp >= 0 ? cmdArg.Substring(sp + 1).Trim() : "";
        string value = (Arg("value", null) ?? Arg("rawInput", null) ?? cmdRest ?? "").Trim();

        // 3) Dispatch style: if the token isn't a known command but the first input word
        //    is, treat input0 as the token and the rest of rawInput as the value.
        if (Array.IndexOf(Known, token) < 0)
        {
            string in0 = (Arg("input0", "") ?? "").Trim().ToLowerInvariant();
            if (Array.IndexOf(Known, in0) >= 0)
            {
                token = in0;
                string ri = (Arg("rawInput", "") ?? "").Trim();
                int s2 = ri.IndexOf(' ');
                value = (s2 >= 0 ? ri.Substring(s2 + 1) : "").Trim();
            }
        }

        CPH.LogInfo("[Linescore Command] token='" + token + "' value='" + value + "'");

        Derived before = Derive();
        string warning = null;
        if (!Apply(token, value, before, ref warning))
        {
            CPH.LogWarn("[Linescore Command] ignored: '" + token + " " + value + "' — " + (warning ?? "not a command this can do now"));
            return false;
        }
        if (warning != null) CPH.LogWarn("[Linescore Command] " + warning);
        if (!before.TiedAtCap && Derive().TiedAtCap)
            CPH.LogWarn("[Linescore Command] still tied at the " + MaxColumns + "-column cap: no more columns, so it stands as a draw.");

        // Same action the overlay's DoAction-on-connect fires, so live edits and sync
        // share one code path.
        CPH.RunAction("Linescore Push");
        return true;
    }

    // Returns false when the command is rejected and nothing changed. `warning` carries
    // the reason, or a caution on a command that still applied.
    bool Apply(string token, string value, Derived d, ref string warning)
    {
        if (token == "t1win" || token == "t2win") return Win(token[1] == '1' ? 0 : 1, d, ref warning);

        if (token == "t1+" || token == "t1-" || token == "t2+" || token == "t2-")
        {
            if (d.Live < 0) { warning = "there's no live inning"; return false; }
            int t = token[1] == '1' ? 0 : 1;
            int next = Clamp(d.Cell(t, d.Live).GetValueOrDefault() + (token[2] == '+' ? 1 : -1), 0, CellMax);
            string snap = Snapshot();
            SetCell(t, d.Live, next);
            KeepUndo(snap);
            return true;
        }

        if (token == "t1" || token == "t2") return Direct(token[1] == '1' ? 0 : 1, value, ref warning);

        int label = Array.IndexOf(LabelKeys, token);
        if (label >= 0) return Label(LabelKeys[label], value, ref warning);

        switch (token)
        {
            case "undo": return Undo(ref warning);
            case "next":
            {
                if (d.Fixed) { warning = "`next` is for free entry: fixed points move on by themselves"; return false; }
                if (d.Live < 0) { warning = "there's no live inning"; return false; }
                if (Refused("next")) { warning = GuardWarning("next"); return false; }
                Stamp("next");
                string snap = Snapshot();
                if (!d.Cell(0, d.Live).HasValue) SetCell(0, d.Live, 0);
                if (!d.Cell(1, d.Live).HasValue) SetCell(1, d.Live, 0);
                Set("ls.live", Num(d.Live + 1));
                KeepUndo(snap);
                return true;
            }
            case "t1name": Set("ls.t1name", value); return true;
            case "t2name": Set("ls.t2name", value); return true;
            case "innings":
            {
                int n;
                if (!TryInt(value, out n)) { warning = "innings needs a number"; return false; }
                int innings = Clamp(n, 1, MaxColumns);
                Set("ls.innings", Num(innings));
                if (d.Fixed && innings > d.Worth.Length)
                    warning = "innings past the end of the points list take the extra's points (" + d.ExtraWorth + ")";
                return true;
            }
            case "worth": return Worth(value, ref warning);
            case "free":
                Set("ls.live", Num(d.Live < 0 ? d.Shown - 1 : d.Live));
                Set("ls.mode", "free");
                return true;
            case "extra":
            {
                string v = value.ToLowerInvariant();
                if (v != "on" && v != "off") { warning = "extra takes on or off"; return false; }
                Set("ls.extra", v);
                return true;
            }
            case "title": Set("ls.title", value); return true;
            case "collabel": Set("ls.collabel", value); return true;
            case "extralabel": Set("ls.extralabel", value); return true;
            case "totallabel": Set("ls.totallabel", value); return true;
            case "preset":
            {
                string which = value.ToLowerInvariant();
                if (which != "sfl" && which != "baseball") { warning = "presets are sfl and baseball"; return false; }
                string snap = Snapshot();
                ApplyPreset(which == "sfl");
                KeepUndo(snap);
                return true;
            }
            case "reset":
            {
                string snap = Snapshot();
                ClearScores();
                ResetLabelValues();
                KeepUndo(snap);
                return true;
            }
            case "hide": Set("ls.hidden", "1"); return true;
            case "show": Set("ls.hidden", "0"); return true;
            case "setmany": return SetMany(ref warning);
            default:
                warning = "unknown command";
                return false;
        }
    }

    bool Win(int winner, Derived d, ref string warning)
    {
        if (!d.Fixed) { warning = "winner commands need fixed points (`worth` or `preset sfl`)"; return false; }
        if (d.Live < 0) { warning = "the match is over"; return false; }

        if (Refused("win")) { warning = GuardWarning("win"); return false; }
        Stamp("win");

        string snap = Snapshot();
        SetCell(winner, d.Live, ColumnWorth(d, d.Live));
        SetCell(1 - winner, d.Live, 0);
        KeepUndo(snap);
        return true;
    }

    // Two people typing the same thing, or a panel click on top of a chat command, must not
    // count twice: stream delay plus typing puts them seconds apart. Only panel-after-panel
    // is free, because the panel handles its own double-clicks and a burst there is deliberate.
    bool Refused(string key)
    {
        long last;
        if (!long.TryParse(Var("ls.last" + key, ""), NumberStyles.None, CultureInfo.InvariantCulture, out last)) return false;
        long since = Now() - last;
        if (since < 0 || since >= ChatGuardMs) return false;
        return !(Arg("source", "") == "panel" && Var("ls.last" + key + "from", "") == "panel");
    }

    void Stamp(string key)
    {
        Set("ls.last" + key, Now().ToString(CultureInfo.InvariantCulture));
        Set("ls.last" + key + "from", Arg("source", "") == "panel" ? "panel" : "chat");
    }

    void ClearGuard(string key)
    {
        Set("ls.last" + key, "");
        Set("ls.last" + key + "from", "");
    }

    static string GuardWarning(string key)
    {
        return "another " + key + " landed under " + (ChatGuardMs / 1000) + " seconds ago, so this looks like a repeat";
    }

    long Now()
    {
        long now;
        return long.TryParse(Arg("_now", null) ?? "", NumberStyles.None, CultureInfo.InvariantCulture, out now)
            ? now : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    // `t1 3 20` sets team 1's inning 3 to 20; `t1 3 -` clears it.
    bool Direct(int team, string value, ref string warning)
    {
        string[] parts = value.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        int n, v = 0;
        if (parts.Length != 2 || !TryInt(parts[0], out n) || n < 1 || n > MaxColumns || (parts[1] != "-" && !TryInt(parts[1], out v)))
        {
            warning = "expected an inning from 1 to " + MaxColumns + " and a number or -";
            return false;
        }
        string snap = Snapshot();
        if (parts[1] == "-") SetCell(team, n - 1, null);
        else SetCell(team, n - 1, Clamp(v, 0, CellMax));
        KeepUndo(snap);
        return true;
    }

    bool Label(string key, string value, ref string warning)
    {
        string lower = value.ToLowerInvariant();
        int n;
        if (lower == "on" || lower == "off") Set("ls." + key + ".on", lower == "on" ? "1" : "0");
        else if (lower.Length > 5 && lower.StartsWith("name", StringComparison.Ordinal) && char.IsWhiteSpace(lower[4])) Set("ls." + key + ".name", value.Substring(5).Trim());
        else if (TryInt(value, out n)) Set("ls." + key + ".value", Num(Clamp(n, 0, CellMax)));
        else { warning = "expected a number, on, off, or name <text>"; return false; }
        return true;
    }

    bool Undo(ref string warning)
    {
        List<string> lines = UndoLines();
        if (lines.Count == 0) { warning = "nothing to undo"; return false; }
        if (Refused("undo")) { warning = GuardWarning("undo"); return false; }
        string[] snap = lines[lines.Count - 1].Split('|');
        lines.RemoveAt(lines.Count - 1);
        Set("ls.t1scores", snap[0]);
        Set("ls.t2scores", snap[1]);
        Set("ls.live", snap[2]);
        Set("ls.undo", string.Join("\n", lines.ToArray()));
        ClearGuard("win"); // the correction comes straight after
        ClearGuard("next");
        Stamp("undo");
        return true;
    }

    // `worth 10 10 20 x5`: fixed points, the x marking the extra's. The list also sets
    // the innings count, because the two only make sense together.
    bool Worth(string value, ref string warning)
    {
        string[] parts = value.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        var list = new List<string>();
        int extra = -1;
        foreach (string p in parts)
        {
            bool isExtra = p.StartsWith("x", StringComparison.OrdinalIgnoreCase);
            int n;
            if (!TryInt(isExtra ? p.Substring(1) : p, out n)) { warning = "expected numbers, like 10 10 20 x5"; return false; }
            if (isExtra) extra = Clamp(n, 0, CellMax); else list.Add(Num(Clamp(n, 0, CellMax)));
        }
        if (list.Count == 0 || list.Count > MaxColumns) { warning = "expected 1 to " + MaxColumns + " numbers"; return false; }
        Set("ls.mode", "fixed");
        Set("ls.worth", string.Join(",", list.ToArray()));
        Set("ls.innings", Num(list.Count));
        if (extra >= 0) Set("ls.extraworth", Num(extra));
        return true;
    }

    // One Set click in the panel: every present field in ONE DoAction, because two
    // DoActions to one action within a few ms bleed their arguments together.
    bool SetMany(ref string warning)
    {
        string[,] fields = {
            { "t1name", "ls.t1name" }, { "t2name", "ls.t2name" }, { "title", "ls.title" },
            { "collabel", "ls.collabel" }, { "extralabel", "ls.extralabel" }, { "totallabel", "ls.totallabel" },
            { "ballname", "ls.ball.name" }, { "strikename", "ls.strike.name" }, { "outname", "ls.out.name" },
        };
        bool any = false;
        for (int i = 0; i < fields.GetLength(0); i++)
        {
            string v = Arg(fields[i, 0], null);
            if (v != null) { Set(fields[i, 1], v.Trim()); any = true; }
        }
        if (!any) warning = "setmany got no fields";
        return any;
    }

    void ApplyPreset(bool sfl)
    {
        Set("ls.mode", sfl ? "fixed" : "free");
        Set("ls.innings", sfl ? "3" : "9");
        Set("ls.worth", sfl ? "10,10,20" : "");
        Set("ls.extraworth", "5");
        Set("ls.extra", "on");
        Set("ls.collabel", sfl ? "SET" : "");
        Set("ls.extralabel", sfl ? "EXTRA" : "");
        Set("ls.totallabel", sfl ? "TOTAL" : "R");
        Set("ls.title", sfl ? "TEAM BATTLE" : "");
        Set("ls.hidden", "0"); // setting up a format means the board is wanted, even if last night ended on hide
        for (int i = 0; i < LabelKeys.Length; i++)
        {
            Set("ls." + LabelKeys[i] + ".on", sfl ? "0" : "1");
            Set("ls." + LabelKeys[i] + ".name", LabelNames[i]);
        }
        ResetLabelValues();
        ClearScores();
    }

    void ClearScores()
    {
        Set("ls.t1scores", "");
        Set("ls.t2scores", "");
        Set("ls.live", "0");
        ClearGuard("win");
        ClearGuard("undo");
        ClearGuard("next");
    }

    void ResetLabelValues()
    {
        foreach (string key in LabelKeys) Set("ls." + key + ".value", "0");
    }

    string Snapshot()
    {
        return Var("ls.t1scores", "") + "|" + Var("ls.t2scores", "") + "|" + Var("ls.live", "0");
    }

    // Remember the state from before a scoring change, if the change altered anything.
    void KeepUndo(string snap)
    {
        if (Snapshot() == snap) return;
        List<string> lines = UndoLines();
        lines.Add(snap);
        if (lines.Count > UndoMax) lines.RemoveRange(0, lines.Count - UndoMax);
        Set("ls.undo", string.Join("\n", lines.ToArray()));
    }

    List<string> UndoLines()
    {
        var lines = new List<string>();
        foreach (string l in Var("ls.undo", "").Split('\n'))
            if (l.Split('|').Length == 3) lines.Add(l);
        return lines;
    }

    void SetCell(int team, int i, int? v)
    {
        string key = team == 0 ? "ls.t1scores" : "ls.t2scores";
        int?[] cur = ParseScores(Var(key, ""));
        var cells = new int?[Math.Max(cur.Length, i + 1)];
        Array.Copy(cur, cells, cur.Length);
        cells[i] = v;
        int end = cells.Length;
        while (end > 0 && !cells[end - 1].HasValue) end--;
        var sb = new StringBuilder();
        for (int c = 0; c < end; c++)
        {
            if (c > 0) sb.Append(',');
            if (cells[c].HasValue) sb.Append(Num(cells[c].Value));
        }
        Set(key, sb.ToString());
    }

    void Set(string key, string value) { CPH.SetGlobalVar(key, value, true); }
    string Arg(string key, string dflt) { string a; return CPH.TryGetArg(key, out a) ? a : dflt; }
    static string Num(int n) { return n.ToString(CultureInfo.InvariantCulture); }

    // @rules
}
