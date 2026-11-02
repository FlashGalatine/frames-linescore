    // ── Shared rules (actions/src/rules.cs): both actions carry an identical copy, ──
    // ── because Streamer.bot actions can't share code. Edit there, not here.       ──
    const int MaxColumns = 12;
    const int CellMax = 99;

    class Derived
    {
        public int Innings;
        public bool Fixed;
        public int[] Worth;
        public int ExtraWorth;
        public bool ExtraOn;
        public int?[][] Cells = new int?[2][];
        public int[] Totals = new int[2];
        public int Shown;
        public bool Over;
        public int Lead = -1;   // -1 = nobody leads
        public int Live = -1;   // -1 = no live column
        public bool TiedAtCap;

        public int? Cell(int team, int i) { int?[] c = Cells[team]; return i < c.Length ? c[i] : (int?)null; }
        public bool Recorded(int i) { return Cell(0, i).HasValue && Cell(1, i).HasValue; }
        public bool AllRecorded(int n) { for (int i = 0; i < n; i++) if (!Recorded(i)) return false; return true; }
    }

    // Everything a theme or a command needs to know, worked out from the stored state.
    Derived Derive()
    {
        var d = new Derived();
        int n;
        d.Innings = Clamp(TryInt(Var("ls.innings", "9"), out n) ? n : 9, 1, MaxColumns);
        d.Fixed = Var("ls.mode", "free") == "fixed";
        d.Worth = ParseWorth(Var("ls.worth", ""));
        d.ExtraWorth = TryInt(Var("ls.extraworth", "5"), out n) ? Clamp(n, 0, CellMax) : 5;
        d.ExtraOn = Var("ls.extra", "on") != "off";
        d.Cells[0] = ParseScores(Var("ls.t1scores", ""));
        d.Cells[1] = ParseScores(Var("ls.t2scores", ""));
        for (int t = 0; t < 2; t++)
            foreach (int? v in d.Cells[t]) d.Totals[t] += v.GetValueOrDefault();

        int highest = -1;
        for (int i = 0; i < MaxColumns; i++)
            if (d.Cell(0, i).HasValue || d.Cell(1, i).HasValue) highest = i;
        d.Shown = Math.Max(d.Innings, highest + 1);
        while (d.AllRecorded(d.Shown) && d.Totals[0] == d.Totals[1] && d.ExtraOn && d.Shown < MaxColumns) d.Shown++;

        d.Over = d.AllRecorded(d.Shown);
        d.Lead = d.Totals[0] > d.Totals[1] ? 0 : d.Totals[1] > d.Totals[0] ? 1 : -1;
        if (!d.Over)
        {
            if (d.Fixed)
            {
                for (int i = 0; i < d.Shown; i++)
                    if (!d.Recorded(i)) { d.Live = i; break; }
            }
            else
            {
                d.Live = Clamp(TryInt(Var("ls.live", "0"), out n) ? n : 0, 0, d.Shown - 1);
            }
        }
        d.TiedAtCap = d.Over && d.Totals[0] == d.Totals[1] && d.ExtraOn && d.Shown == MaxColumns;
        return d;
    }

    // What a column is worth in fixed mode: its listed points, else the extra's.
    static int ColumnWorth(Derived d, int i)
    {
        return i < d.Innings && i < d.Worth.Length ? d.Worth[i] : d.ExtraWorth;
    }

    static int?[] ParseScores(string csv)
    {
        string[] parts = (csv ?? "").Split(',');
        var cells = new int?[Math.Min(parts.Length, MaxColumns)];
        for (int i = 0; i < cells.Length; i++)
        {
            int n;
            if (TryInt(parts[i], out n)) cells[i] = Clamp(n, 0, CellMax);
        }
        return cells;
    }

    static int[] ParseWorth(string csv)
    {
        string t = (csv ?? "").Trim();
        if (t.Length == 0) return new int[0];
        string[] parts = t.Split(',');
        var list = new int[parts.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            int n;
            list[i] = TryInt(parts[i], out n) ? Clamp(n, 0, CellMax) : 0;
        }
        return list;
    }

    // GetGlobalVar returns null when unset: fall back to the default, but keep an
    // explicitly-set empty string. A variable hand-edited to a non-string must not stop the
    // board, so a failed read tries it as an object, then falls back too.
    string Var(string key, string dflt)
    {
        try
        {
            var v = CPH.GetGlobalVar<string>(key, true);
            return v == null ? dflt : v;
        }
        catch (Exception)
        {
            try
            {
                var o = CPH.GetGlobalVar<object>(key, true);
                return o == null ? dflt : Convert.ToString(o, CultureInfo.InvariantCulture);
            }
            catch (Exception) { return dflt; }
        }
    }

    static bool TryInt(string s, out int n)
    {
        return int.TryParse((s ?? "").Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out n);
    }

    static int Clamp(int v, int lo, int hi) { return Math.Min(hi, Math.Max(lo, v)); }
    // ── End of shared rules ──
