// XAE bridge of Explorer for TwinCAT's MCP server: drives the TwinCAT XAE instances already running on this desktop
// (found in the Running Object Table) through their Automation Interface, in JSON lines: one request per line on
// stdin, one answer per request on stdout. Compiled on the user's machine by src/mcp/xae.ts with the .NET
// Framework's csc.exe (C# 5) against the XAE's own automation assemblies.
//
// Every request runs on one STA worker thread that keeps the COM objects. A request that does not finish in its
// timeout (a modal dialog of XAE blocks every call) is answered with the texts of XAE's dialogs, and the bridge
// then exits so that the blocked call dies with it; the MCP server starts a new one for the next request.
// The bridge never brings a window to the front, never types into XAE and never answers its dialogs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using EnvDTE;
using EnvDTE80;
using TCatSysManagerLib;

namespace TwinCatXaeBridge {

    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleMessageFilter {
        [PreserveSig] int HandleInComingCall(int callType, IntPtr callerTask, int tickCount, IntPtr interfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr calleeTask, int tickCount, int rejectType);
        [PreserveSig] int MessagePending(IntPtr calleeTask, int tickCount, int pendingType);
    }

    // XAE rejects calls while it is busy (opening a solution, building): they are retried every 100 ms; the
    // request's timeout ends the wait.
    class MessageFilter : IOleMessageFilter {
        [DllImport("ole32.dll")] static extern int CoRegisterMessageFilter(IOleMessageFilter f, out IOleMessageFilter old);
        public static void Register() { IOleMessageFilter old; CoRegisterMessageFilter(new MessageFilter(), out old); }
        int IOleMessageFilter.HandleInComingCall(int a, IntPtr b, int c, IntPtr d) { return 0; }
        int IOleMessageFilter.RetryRejectedCall(IntPtr a, int tick, int type) { return type == 2 ? 100 : -1; }
        int IOleMessageFilter.MessagePending(IntPtr a, int b, int c) { return 2; }
    }

    class BridgeError : Exception { public BridgeError(string m) : base(m) { } }

    // The visible standard dialogs (#32770) of a process and their texts, through window messages only.
    static class Dialogs {
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

        static string Text(IntPtr h) { StringBuilder s = new StringBuilder(1024); GetWindowText(h, s, 1024); return s.ToString(); }
        static string Class(IntPtr h) { StringBuilder s = new StringBuilder(128); GetClassName(h, s, 128); return s.ToString(); }

        public static List<string> Of(int pid) {
            List<string> found = new List<string>();
            EnumWindows(delegate(IntPtr h, IntPtr l) {
                uint p; GetWindowThreadProcessId(h, out p);
                if (p != (uint)pid || !IsWindowVisible(h) || Class(h) != "#32770") return true;
                List<string> parts = new List<string>();
                string title = Text(h);
                if (title.Length > 0) parts.Add(title);
                EnumChildWindows(h, delegate(IntPtr c, IntPtr m) {
                    string cls = Class(c);
                    string t = Text(c);
                    if (t.Length > 0 && (cls == "Static" || cls == "Button")) parts.Add(t.Replace("&", ""));
                    return true;
                }, IntPtr.Zero);
                found.Add(string.Join(" | ", parts.ToArray()));
                return true;
            }, IntPtr.Zero);
            return found;
        }
    }

    static class Program {
        [DllImport("ole32.dll")] static extern int GetRunningObjectTable(int r, out IRunningObjectTable rot);
        [DllImport("ole32.dll")] static extern int CreateBindCtx(int r, out IBindCtx ctx);

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static readonly object OutLock = new object();
        static readonly Dictionary<int, DTE2> Instances = new Dictionary<int, DTE2>();

        static void Write(Dictionary<string, object> answer) {
            lock (OutLock) {
                Console.Out.WriteLine(Json.Serialize(answer));
                Console.Out.Flush();
            }
        }

        // ------------------------------------------------------------------ instances

        // "!TcXaeShell.DTE.15.0:1234", "!VisualStudio.DTE.17.0:1234": the running XAEs (and Visual Studios with TwinCAT).
        static Dictionary<int, KeyValuePair<string, object>> RunningObjects() {
            Dictionary<int, KeyValuePair<string, object>> found = new Dictionary<int, KeyValuePair<string, object>>();
            IRunningObjectTable rot; IBindCtx ctx;
            GetRunningObjectTable(0, out rot); CreateBindCtx(0, out ctx);
            IEnumMoniker e; rot.EnumRunning(out e);
            IMoniker[] m = new IMoniker[1];
            while (e.Next(1, m, IntPtr.Zero) == 0) {
                string name;
                try { m[0].GetDisplayName(ctx, null, out name); } catch { continue; }
                if (!(name.StartsWith("!TcXaeShell.DTE.") || name.StartsWith("!VisualStudio.DTE."))) continue;
                int colon = name.LastIndexOf(':');
                int pid;
                if (colon < 0 || !int.TryParse(name.Substring(colon + 1), out pid)) continue;
                object o;
                try { rot.GetObject(m[0], out o); } catch { continue; }
                found[pid] = new KeyValuePair<string, object>(name.Substring(1, colon - 1), o);
            }
            return found;
        }

        static object ListInstances() {
            List<object> list = new List<object>();
            Instances.Clear();
            foreach (KeyValuePair<int, KeyValuePair<string, object>> kv in RunningObjects()) {
                DTE2 dte = kv.Value.Value as DTE2;
                if (dte == null) continue;
                Instances[kv.Key] = dte;
                Dictionary<string, object> info = new Dictionary<string, object>();
                info["pid"] = kv.Key;
                info["progId"] = kv.Value.Key;
                List<string> projects = new List<string>();
                try {
                    info["solution"] = dte.Solution.IsOpen ? dte.Solution.FullName : "";
                    foreach (Project p in dte.Solution.Projects) {
                        try { if (p.Object is ITcSysManager) projects.Add(p.FullName); } catch { }
                    }
                } catch (Exception ex) {
                    info["error"] = ex.Message;
                }
                info["projects"] = projects;
                list.Add(info);
            }
            return list;
        }

        static DTE2 Dte(int pid) {
            DTE2 dte;
            if (Instances.TryGetValue(pid, out dte)) {
                try { string _ = dte.Solution.FullName; return dte; } catch { Instances.Remove(pid); }
            }
            ListInstances();
            if (!Instances.TryGetValue(pid, out dte)) throw new BridgeError("TwinCAT XAE (process " + pid + ") is no longer running");
            return dte;
        }

        static ITcSysManager SysManager(DTE2 dte, string tsproj) {
            foreach (Project p in dte.Solution.Projects) {
                ITcSysManager sm = null;
                try { sm = p.Object as ITcSysManager; } catch { }
                if (sm != null && string.Equals(Path.GetFullPath(p.FullName), Path.GetFullPath(tsproj), StringComparison.OrdinalIgnoreCase)) return sm;
            }
            throw new BridgeError("TwinCAT XAE has no project " + tsproj + " open");
        }

        // ------------------------------------------------------------------ tree items

        // The PLC project's nested IEC project ("<Plc> Project" in an English XAE), found language-independently.
        static ITcSmTreeItem Nested(ITcSysManager sm, string plc) {
            ITcSmTreeItem root = sm.LookupTreeItem("TIPC^" + plc);
            ITcProjectRoot pr = root as ITcProjectRoot;
            if (pr != null) {
                ITcSmTreeItem nested = pr.NestedProject as ITcSmTreeItem;
                if (nested != null) return nested;
            }
            return sm.LookupTreeItem("TIPC^" + plc + "^" + plc + " Project");
        }

        static ITcSmTreeItem Item(Dictionary<string, object> r) {
            ITcSysManager sm = SysManager(Dte(Int(r, "pid")), Str(r, "tsproj"));
            ITcSmTreeItem nested = Nested(sm, Str(r, "plc"));
            string path = nested.PathName;
            foreach (object seg in (ArrayList)r["path"]) path += "^" + seg;
            try {
                return sm.LookupTreeItem(path);
            } catch (Exception) {
                throw new BridgeError("TwinCAT XAE has no item " + path);
            }
        }

        static string Normalize(string s) { return s.Replace("\r\n", "\n").Replace("\r", "\n"); }

        static string Hash(string text) {
            using (SHA1 sha = SHA1.Create()) {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(Normalize(text)));
                StringBuilder b = new StringBuilder();
                foreach (byte x in h) b.Append(x.ToString("x2"));
                return b.ToString();
            }
        }

        static string GetText(ITcSmTreeItem item, string part) {
            if (part == "decl") {
                ITcPlcDeclaration d = item as ITcPlcDeclaration;
                if (d == null) throw new BridgeError(item.Name + " has no declaration in TwinCAT XAE");
                return Normalize(d.DeclarationText);
            }
            ITcPlcImplementation i = item as ITcPlcImplementation;
            if (i == null) throw new BridgeError(item.Name + " has no implementation in TwinCAT XAE");
            return Normalize(i.ImplementationText);
        }

        static void SetText(ITcSmTreeItem item, string part, string text) {
            if (part == "decl") ((ITcPlcDeclaration)item).DeclarationText = text;
            else ((ITcPlcImplementation)item).ImplementationText = text;
        }

        // Whether the file is open in an editor of XAE, and has changes there that are not saved.
        static Dictionary<string, object> DocState(DTE2 dte, string file) {
            Dictionary<string, object> state = new Dictionary<string, object>();
            state["open"] = false;
            state["dirty"] = false;
            if (string.IsNullOrEmpty(file)) return state;
            string full = Path.GetFullPath(file);
            foreach (Document d in dte.Documents) {
                string name;
                try { name = d.FullName; } catch { continue; }
                if (!string.Equals(Path.GetFullPath(name), full, StringComparison.OrdinalIgnoreCase)) continue;
                state["open"] = true;
                try { if (!d.Saved) state["dirty"] = true; } catch { state["dirty"] = true; }
            }
            return state;
        }

        // The project of a project file, at any depth (a PLC project is nested in the TwinCAT project).
        static Project FindProject(IEnumerable projects, string full) {
            foreach (object o in projects) {
                Project p = o as Project;
                if (p == null) {
                    ProjectItem pi = o as ProjectItem;
                    if (pi != null) { try { p = pi.SubProject; } catch { } }
                }
                if (p == null) continue;
                try {
                    if (string.Equals(Path.GetFullPath(p.FullName), full, StringComparison.OrdinalIgnoreCase)) return p;
                } catch { }
                try {
                    Project inner = FindProject(p.ProjectItems, full);
                    if (inner != null) return inner;
                } catch { }
            }
            return null;
        }

        static string BuildPane(DTE2 dte) {
            foreach (OutputWindowPane p in dte.ToolWindows.OutputWindow.OutputWindowPanes) {
                if (!string.Equals(p.Guid, "{1BD8A850-02D1-11D1-BEE7-00A0C913D1F8}", StringComparison.OrdinalIgnoreCase)) continue;
                try {
                    TextSelection sel = p.TextDocument.Selection;
                    sel.StartOfDocument(false); sel.EndOfDocument(true);
                    return sel.Text;
                } catch { return ""; } // empty until something was written to it
            }
            return "";
        }

        // ------------------------------------------------------------------ requests

        static string Str(Dictionary<string, object> r, string k) { object v; return r.TryGetValue(k, out v) && v != null ? v.ToString() : null; }
        static int Int(Dictionary<string, object> r, string k) { return Convert.ToInt32(r[k]); }

        static object Run(Dictionary<string, object> r) {
            string cmd = Str(r, "cmd");
            switch (cmd) {
                case "instances":
                    return ListInstances();
                case "get": {
                    ITcSmTreeItem item = Item(r);
                    Dictionary<string, object> a = DocState(Dte(Int(r, "pid")), Str(r, "file"));
                    string text = GetText(item, Str(r, "part"));
                    a["text"] = text;
                    a["hash"] = Hash(text);
                    return a;
                }
                case "set": {
                    // The text is set only when XAE's text still has the hash the caller read; XAE saves the object at once.
                    ITcSmTreeItem item = Item(r);
                    string part = Str(r, "part");
                    string current = GetText(item, part);
                    string expected = Str(r, "expected");
                    if (expected != null && Hash(current) != expected) {
                        Dictionary<string, object> c = new Dictionary<string, object>();
                        c["conflict"] = true;
                        c["text"] = current;
                        c["hash"] = Hash(current);
                        return c;
                    }
                    SetText(item, part, Str(r, "text"));
                    Dictionary<string, object> a = DocState(Dte(Int(r, "pid")), Str(r, "file"));
                    string now = GetText(item, part);
                    a["text"] = now;
                    a["hash"] = Hash(now);
                    return a;
                }
                case "doc":
                    return DocState(Dte(Int(r, "pid")), Str(r, "file"));
                case "save": {
                    // Saves the documents of one file only (a new member lives in memory until its file is saved).
                    DTE2 dte = Dte(Int(r, "pid"));
                    string full = Path.GetFullPath(Str(r, "file"));
                    int saved = 0;
                    foreach (Document d in dte.Documents) {
                        string name;
                        try { name = d.FullName; } catch { continue; }
                        if (!string.Equals(Path.GetFullPath(name), full, StringComparison.OrdinalIgnoreCase)) continue;
                        d.Save();
                        saved++;
                    }
                    if (saved == 0) {
                        // Not open in an editor: a project file (.plcproj) is saved through its project.
                        Project p = FindProject(dte.Solution.Projects, full);
                        // A PLC project is not a project of its own to DTE: the TwinCAT project that holds it saves it.
                        if (p == null && Str(r, "tsproj") != null) p = FindProject(dte.Solution.Projects, Path.GetFullPath(Str(r, "tsproj")));
                        if (p != null) { p.Save(); saved++; }
                    }
                    Dictionary<string, object> a = DocState(dte, full);
                    a["saved"] = saved;
                    return a;
                }
                case "dirty": {
                    // The files with unsaved changes in XAE's editors.
                    List<string> files = new List<string>();
                    foreach (Document d in Dte(Int(r, "pid")).Documents) {
                        try { if (!d.Saved) files.Add(d.FullName); } catch { }
                    }
                    return files;
                }
                case "children": {
                    ITcSmTreeItem item = Item(r);
                    List<object> kids = new List<object>();
                    for (int i = 1; i <= item.ChildCount; i++) {
                        ITcSmTreeItem c = item.get_Child(i);
                        Dictionary<string, object> k = new Dictionary<string, object>();
                        k["name"] = c.Name;
                        k["type"] = c.ItemSubType;
                        kids.Add(k);
                    }
                    return kids;
                }
                case "create": {
                    // A child of an item (a member of a POU, an object in a folder), then its declaration as given.
                    ITcSmTreeItem parent = Item(r);
                    ArrayList info = r.ContainsKey("info") ? (ArrayList)r["info"] : null;
                    object vInfo = null;
                    if (info != null) {
                        object[] arr = new object[info.Count];
                        for (int i = 0; i < info.Count; i++) arr[i] = info[i];
                        vInfo = arr;
                    }
                    ITcSmTreeItem child = parent.CreateChild(Str(r, "name"), Int(r, "subType"), "", vInfo);
                    if (child == null) throw new BridgeError("TwinCAT XAE did not create " + Str(r, "name"));
                    string decl = Str(r, "decl");
                    if (decl != null) ((ITcPlcDeclaration)child).DeclarationText = decl;
                    Dictionary<string, object> a = new Dictionary<string, object>();
                    a["path"] = child.PathName;
                    return a;
                }
                case "delete": {
                    ITcSmTreeItem parent = Item(r);
                    parent.DeleteChild(Str(r, "name"));
                    return new Dictionary<string, object>();
                }
                case "check": {
                    DTE2 dte = Dte(Int(r, "pid"));
                    ITcSmTreeItem nested = Nested(SysManager(dte, Str(r, "tsproj")), Str(r, "plc"));
                    int before = BuildPane(dte).Length;
                    ((ITcPlcIECProject2)nested).CheckAllObjects();
                    // XAE writes to the Build pane asynchronously, up to about a second after the call returns.
                    string text = BuildPane(dte);
                    for (int i = 0; i < 50 && text.IndexOf("Compile complete", Math.Min(before, text.Length), StringComparison.Ordinal) < 0; i++) {
                        System.Threading.Thread.Sleep(100);
                        text = BuildPane(dte);
                    }
                    Dictionary<string, object> a = new Dictionary<string, object>();
                    a["output"] = text.Substring(Math.Min(before, text.Length));
                    return a;
                }
                default:
                    throw new BridgeError("unknown command " + cmd);
            }
        }

        [STAThread]
        static void Main() {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            // The worker thread: one STA for all COM objects, fed by a queue.
            Queue<KeyValuePair<Dictionary<string, object>, ManualResetEvent>> queue = new Queue<KeyValuePair<Dictionary<string, object>, ManualResetEvent>>();
            Dictionary<string, object> lastAnswer = null;
            System.Threading.Thread worker = new System.Threading.Thread(delegate() {
                MessageFilter.Register();
                while (true) {
                    KeyValuePair<Dictionary<string, object>, ManualResetEvent> job;
                    lock (queue) {
                        while (queue.Count == 0) Monitor.Wait(queue);
                        job = queue.Dequeue();
                    }
                    Dictionary<string, object> answer = new Dictionary<string, object>();
                    answer["id"] = job.Key.ContainsKey("id") ? job.Key["id"] : null;
                    try {
                        answer["result"] = Run(job.Key);
                        answer["ok"] = true;
                    } catch (Exception ex) {
                        Exception inner = ex;
                        while (inner.InnerException != null) inner = inner.InnerException;
                        answer["ok"] = false;
                        answer["error"] = inner is BridgeError ? inner.Message : inner.GetType().Name + ": " + inner.Message;
                    }
                    lastAnswer = answer;
                    job.Value.Set();
                }
            });
            worker.SetApartmentState(ApartmentState.STA);
            worker.IsBackground = true;
            worker.Start();

            string line;
            while ((line = Console.In.ReadLine()) != null) {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> request;
                try {
                    request = Json.Deserialize<Dictionary<string, object>>(line);
                } catch (Exception ex) {
                    Dictionary<string, object> bad = new Dictionary<string, object>();
                    bad["id"] = null; bad["ok"] = false; bad["error"] = "bad request: " + ex.Message;
                    Write(bad);
                    continue;
                }
                if (Str(request, "cmd") == "dialogs") {
                    // Answered here, not on the worker: it is what to ask while the worker is blocked.
                    Dictionary<string, object> d = new Dictionary<string, object>();
                    d["id"] = request["id"]; d["ok"] = true; d["result"] = Dialogs.Of(Int(request, "pid"));
                    Write(d);
                    continue;
                }
                ManualResetEvent done = new ManualResetEvent(false);
                lock (queue) {
                    queue.Enqueue(new KeyValuePair<Dictionary<string, object>, ManualResetEvent>(request, done));
                    Monitor.Pulse(queue);
                }
                int timeout = request.ContainsKey("timeoutMs") ? Convert.ToInt32(request["timeoutMs"]) : 30000;
                if (done.WaitOne(timeout)) {
                    Write(lastAnswer);
                    continue;
                }
                Dictionary<string, object> late = new Dictionary<string, object>();
                late["id"] = request.ContainsKey("id") ? request["id"] : null;
                late["ok"] = false;
                late["timeout"] = true;
                late["error"] = "TwinCAT XAE did not answer within " + (timeout / 1000) + " s";
                late["dialogs"] = request.ContainsKey("pid") ? Dialogs.Of(Int(request, "pid")) : new List<string>();
                Write(late);
                // The worker is stuck in a COM call: end the process so that the call ends with it.
                Environment.Exit(2);
            }
        }
    }
}
