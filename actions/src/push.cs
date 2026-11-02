using System;
using System.Text;
using System.Globalization;

public class CPHInline
{
    static readonly string[] LabelKeys = { "ball", "strike", "out" };
    static readonly string[] LabelNames = { "Ball", "Strike", "Out" };

    public bool Execute()
    {
        try
        {
            Derived d = Derive();
            var sb = new StringBuilder();
            sb.Append("{\"type\":\"linescore:update\"");
            sb.Append(",\"title\":").Append(JsonStr(Var("ls.title", "")));
            sb.Append(",\"totalLabel\":").Append(JsonStr(Var("ls.totallabel", "R")));
            sb.Append(",\"mode\":").Append(d.Fixed ? "\"fixed\"" : "\"free\"");
            sb.Append(",\"hidden\":").Append(Var("ls.hidden", "0") == "1" ? "true" : "false");

            sb.Append(",\"columns\":[");
            for (int i = 0; i < d.Shown; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"label\":").Append(JsonStr(ColumnLabel(d, i)));
                sb.Append(",\"worth\":").Append(d.Fixed ? Num(ColumnWorth(d, i)) : "null");
                sb.Append(",\"state\":").Append(i == d.Live ? "\"live\"" : d.Recorded(i) ? "\"done\"" : "\"open\"");
                sb.Append(",\"extra\":").Append(i >= d.Innings ? "true" : "false").Append('}');
            }
            sb.Append(']');

            sb.Append(",\"teams\":[");
            AppendTeam(sb, d, 0, Var("ls.t1name", "Visitor"));
            sb.Append(',');
            AppendTeam(sb, d, 1, Var("ls.t2name", "Home"));
            sb.Append(']');

            sb.Append(",\"lead\":").Append(d.Lead < 0 ? "null" : Num(d.Lead));
            sb.Append(",\"over\":").Append(d.Over ? "true" : "false");

            sb.Append(",\"labels\":[");
            for (int i = 0; i < LabelKeys.Length; i++)
            {
                string key = LabelKeys[i];
                int v;
                if (i > 0) sb.Append(',');
                sb.Append("{\"key\":").Append(JsonStr(key));
                sb.Append(",\"name\":").Append(JsonStr(Var("ls." + key + ".name", LabelNames[i])));
                sb.Append(",\"value\":").Append(Num(TryInt(Var("ls." + key + ".value", "0"), out v) ? Clamp(v, 0, CellMax) : 0));
                sb.Append(",\"on\":").Append(Var("ls." + key + ".on", "1") != "0" ? "true" : "false").Append('}');
            }
            sb.Append("]}");

            CPH.WebsocketBroadcastJson(sb.ToString());
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Linescore Push] ERROR: " + ex);
            CPH.WebsocketBroadcastJson("{\"type\":\"linescore:error\",\"message\":" + JsonStr(ex.Message) + "}");
            return false;
        }
    }

    void AppendTeam(StringBuilder sb, Derived d, int team, string name)
    {
        sb.Append("{\"name\":").Append(JsonStr(name)).Append(",\"scores\":[");
        for (int i = 0; i < d.Shown; i++)
        {
            if (i > 0) sb.Append(',');
            int? v = d.Cell(team, i);
            sb.Append(v.HasValue ? Num(v.Value) : "null");
        }
        sb.Append("],\"total\":").Append(Num(d.Totals[team])).Append('}');
    }

    string ColumnLabel(Derived d, int i)
    {
        if (i < d.Innings)
        {
            string prefix = Var("ls.collabel", "");
            return prefix.Length > 0 ? prefix + " " + Num(i + 1) : Num(i + 1);
        }
        string extra = Var("ls.extralabel", "");
        if (extra.Length == 0) return Num(i + 1);
        int ordinal = i - d.Innings + 1;
        return ordinal == 1 ? extra : extra + " " + Num(ordinal);
    }

    static string Num(int n) { return n.ToString(CultureInfo.InvariantCulture); }

    // Minimal, correct JSON string encoder (escapes quotes, backslashes, controls).
    static string JsonStr(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    // @rules
}
