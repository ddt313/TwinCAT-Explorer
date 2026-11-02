// XAE bridge of Explorer for TwinCAT's MCP server: drives the TwinCAT XAE instances already running on this desktop
// (found in the Running Object Table) through their Automation Interface, in JSON lines: one request per line on
// stdin, one answer per request on stdout. Compiled on the user's machine by src/mcp/xae.ts with the .NET
// Framework's csc.exe (C# 5) against the XAE's own automation assemblies.
//
// Every request runs on one STA worker thread that keeps the COM objects. A request that does not finish in its
// timeout (a modal dialog of XAE blocks every call) is answered with the texts of XAE's dialogs, and the bridge
// then exits so that the blocked call dies with it; the MCP server starts a new one for the next request.
// The bridge never types into XAE and never answers its dialogs. It starts XAE and brings it to the front only for
// the requests the user asks for: open and front, for the solution of a project, and openTrialLicense, the only one
// that clicks a button: XAE's 7-day trial license dialog then waits for the security code, which the user reads and
// types; the bridge never reads it. Over ADS it only reads: the routes of this machine, and the license files of a
// system.
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

    // The few Visual Studio shell interfaces the bridge uses, declared here rather than referenced: their interop
    // assemblies differ between XAE and the Visual Studio versions TwinCAT installs into. Unused slots keep the order.
    [ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleServiceProvider {
        [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr obj);
    }

    [ComImport, Guid("a928aa21-ea77-47ac-8a07-355206c94bdd"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVsRunningDocumentTable {
        void RegisterAndLockDocument();
        void LockDocument();
        void UnlockDocument();
        [PreserveSig] int FindAndLockDocument(uint lockType, [MarshalAs(UnmanagedType.LPWStr)] string moniker, out IntPtr hier, out uint item, out IntPtr docData, out uint cookie);
        void RenameDocument();
        void AdviseRunningDocTableEvents();
        void UnadviseRunningDocTableEvents();
        void GetDocumentInfo();
        void NotifyDocumentChanged();
        void NotifyOnAfterSave();
        void GetRunningDocumentsEnum();
        [PreserveSig] int SaveDocuments(uint options, IntPtr hier, uint item, uint cookie);
    }

    [ComImport, Guid("3afae242-b530-11d0-8199-00a0c91bbee3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFileFormat {
        [PreserveSig] int GetClassID(out Guid id);
        [PreserveSig] int IsDirty(out int dirty);
    }

    [ComImport, Guid("d5d49c61-1c0b-4ea1-9adb-a79fb1dbc7b5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVsPersistDocData {
        [PreserveSig] int GetGuidEditorType(out Guid id);
        [PreserveSig] int IsDocDataDirty(out int dirty);
    }

    class BridgeError : Exception { public BridgeError(string m) : base(m) { } }

    // ADS through TwinCAT's own TcAdsDll (4026's router refuses ADS over TCP from this machine), read only: the routes
    // of this machine's AMS router, and the license files of a system, through its TcSystemService (port 10000).
    static class Ads {
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        struct AmsAddr { [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] netId; public ushort port; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);
        [DllImport("TcAdsDll.dll")] static extern int AdsPortOpenEx();
        [DllImport("TcAdsDll.dll")] static extern int AdsPortCloseEx(int port);
        [DllImport("TcAdsDll.dll")] static extern int AdsGetLocalAddressEx(int port, ref AmsAddr addr);
        [DllImport("TcAdsDll.dll")] static extern int AdsSyncSetTimeoutEx(int port, int ms);
        [DllImport("TcAdsDll.dll")] static extern int AdsSyncReadReqEx2(int port, ref AmsAddr addr, uint ig, uint io, uint len, byte[] data, out uint read);
        [DllImport("TcAdsDll.dll")] static extern int AdsSyncReadWriteReqEx2(int port, ref AmsAddr addr, uint ig, uint io, uint rlen, byte[] rdata, uint wlen, byte[] wdata, out uint read);
        [DllImport("TcAdsDll.dll")] static extern int AdsSyncWriteReqEx(int port, ref AmsAddr addr, uint ig, uint io, uint len, byte[] data);

        const uint ENUMREMOTE = 803, FOPEN = 120, FCLOSE = 121, FREAD = 122, FFILEFIND = 133;
        // The path type of the file services, in the index offset's high word: generic, any path.
        const uint GENERIC = 1u << 16;
        const int NO_MORE = 1814;

        // An error of the system's own service (0x700-0x73F: not found, invalid path), unlike one of the router or of
        // this client (no route, timeout): the system answered.
        static bool DeviceError(int e) { return e >= 0x700 && e < 0x740; }

        static bool loaded;
        static void Load() {
            if (loaded) return;
            string x86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)";
            string common = Environment.Is64BitProcess ? "Common64" : "Common32";
            foreach (string dll in new string[] { Path.Combine(x86, @"Beckhoff\TwinCAT\" + common + @"\TcAdsDll.dll"), @"C:\TwinCAT\" + common + @"\TcAdsDll.dll" }) {
                if (File.Exists(dll) && LoadLibrary(dll) != IntPtr.Zero) { loaded = true; return; }
            }
            throw new BridgeError("TwinCAT's TcAdsDll.dll is not installed");
        }

        static string NetId(byte[] b, int at) { return b[at] + "." + b[at + 1] + "." + b[at + 2] + "." + b[at + 3] + "." + b[at + 4] + "." + b[at + 5]; }
        static string Str(byte[] b, int at, int len) { return Encoding.Default.GetString(b, at, Math.Max(0, len)).Split('\0')[0]; }

        // A port of this process to TcSystemService of a system; the local one when netId is null.
        static int Open(string netId, out AmsAddr addr, int timeoutMs) {
            Load();
            int port = AdsPortOpenEx();
            if (port == 0) throw new BridgeError("no ADS port: is the TwinCAT router running?");
            AdsSyncSetTimeoutEx(port, timeoutMs);
            addr = new AmsAddr { netId = new byte[6] };
            if (netId == null) {
                int e = AdsGetLocalAddressEx(port, ref addr);
                if (e != 0) { AdsPortCloseEx(port); throw new BridgeError("ADS error " + e + " getting the local AMS Net ID"); }
            } else {
                addr.netId = Array.ConvertAll(netId.Split('.'), byte.Parse);
            }
            addr.port = 10000;
            return port;
        }

        // The routes of the router, by index until 1814 (4026's end of the list). Another error after the first route
        // ends the list too, so that a router that ends it otherwise still gives the routes before.
        public static Dictionary<string, object> Routes() {
            AmsAddr addr;
            int port = Open(null, out addr, 3000);
            try {
                string local = NetId(addr.netId, 0);
                List<object> routes = new List<object>();
                for (uint i = 0; i < 1000; i++) {
                    byte[] b = new byte[4096]; uint read;
                    int e = AdsSyncReadReqEx2(port, ref addr, ENUMREMOTE, i, (uint)b.Length, b, out read);
                    if (e == NO_MORE || (e != 0 && i > 0)) break;
                    if (e != 0) throw new BridgeError("ADS error " + e + " listing the routes");
                    AddRoutes(b, (int)read, routes);
                }
                Dictionary<string, object> a = new Dictionary<string, object>();
                a["local"] = local;
                a["routes"] = routes;
                return a;
            } finally { AdsPortCloseEx(port); }
        }

        // An entry of ENUMREMOTE, as 4026 gives it: the AMS Net ID (6), the transport (2), flags (4), the timeout (4),
        // 16 reserved, the lengths of the address and of the host name and the number of sub-routes (4 each), the
        // address, the host name, then each sub-route: its AMS Net ID (6), 14 reserved, the length of its name (4), its
        // name. Without sub-routes, the entry is the route. What does not fit in what was read (another layout) is left
        // out.
        static void AddRoutes(byte[] b, int read, List<object> routes) {
            if (read < 44) return;
            int addrLen = BitConverter.ToInt32(b, 32), hostLen = BitConverter.ToInt32(b, 36), subs = BitConverter.ToInt32(b, 40);
            if (addrLen < 0 || hostLen < 0 || subs < 0 || 44L + addrLen + hostLen > read) return;
            string address = Str(b, 44, addrLen), host = Str(b, 44 + addrLen, hostLen);
            if (subs == 0) {
                routes.Add(Route(NetId(b, 0), host.Length > 0 ? host : address, address));
                return;
            }
            int at = 44 + addrLen + hostLen;
            for (int s = 0; s < subs && at + 24 <= read; s++) {
                int nameLen = BitConverter.ToInt32(b, at + 20);
                if (nameLen < 0 || at + 24L + nameLen > read) return;
                routes.Add(Route(NetId(b, at), Str(b, at + 24, nameLen), address));
                at += 24 + nameLen;
            }
        }

        static Dictionary<string, object> Route(string netId, string name, string address) {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["netId"] = netId; r["name"] = name; r["address"] = address;
            return r;
        }

        // Where a system's Target folder may be, with its path separator: %TC_TARGETPATH% (4026, also on Linux), else
        // 4024's on Windows, or TwinCAT/BSD's. Its License folder holds the license files.
        static readonly string[][] Targets = {
            new string[] { "%TC_TARGETPATH%", "\\" },
            new string[] { @"C:\TwinCAT\3.1\Target\", "\\" },
            new string[] { "/usr/local/etc/TwinCAT/3.1/Target/", "/" },
        };

        // The *.tclrs files of a system's License folder, in base64. found: a Target folder was found, so that no file
        // means no license yet; false when none of the places answered, and its license files are not known.
        public static Dictionary<string, object> Licenses(string netId) {
            AmsAddr addr;
            int port = Open(netId, out addr, 3000);
            try {
                List<object> files = new List<object>();
                Dictionary<string, object> a = new Dictionary<string, object>();
                a["found"] = false;
                a["files"] = files;
                foreach (string[] t in Targets) {
                    string folder = t[0] + "License" + t[1];
                    List<string> names = Find(port, ref addr, folder + "*.tclrs");
                    if (names == null && Find(port, ref addr, t[0] + "*") == null) continue;
                    a["found"] = true;
                    foreach (string name in names ?? new List<string>()) {
                        Dictionary<string, object> file = new Dictionary<string, object>();
                        file["name"] = name;
                        file["data"] = Convert.ToBase64String(Read(port, ref addr, folder + name));
                        files.Add(file);
                    }
                    break;
                }
                return a;
            } finally { AdsPortCloseEx(port); }
        }

        // The names of the files that match, or null when none does: the system's service answers a path it does not
        // have with an error of its own (1804 not found), which ends a listing too. Throws when the system does not answer.
        static List<string> Find(int port, ref AmsAddr addr, string pattern) {
            List<string> names = new List<string>();
            byte[] w = Encoding.Default.GetBytes(pattern + "\0");
            uint io = GENERIC;
            for (int n = 0; n < 1000; n++) {
                byte[] b = new byte[324]; uint read;
                int e = AdsSyncReadWriteReqEx2(port, ref addr, FFILEFIND, io, (uint)b.Length, b, (uint)w.Length, w, out read);
                if (e != 0 && !DeviceError(e)) throw new BridgeError("ADS error " + e + " reading the license folder of " + NetId(addr.netId, 0));
                if (e != 0) return n == 0 ? null : names;
                names.Add(Str(b, 48, 260));
                io = BitConverter.ToUInt32(b, 0);
                w = new byte[0];
            }
            return names;
        }

        static byte[] Read(int port, ref AmsAddr addr, string file) {
            byte[] w = Encoding.Default.GetBytes(file + "\0"), h = new byte[4]; uint read;
            // read (1), binary (0x10)
            int e = AdsSyncReadWriteReqEx2(port, ref addr, FOPEN, 1 | 0x10 | GENERIC, 4, h, (uint)w.Length, w, out read);
            if (e != 0) throw new BridgeError("ADS error " + e + " opening " + file);
            uint handle = BitConverter.ToUInt32(h, 0);
            try {
                MemoryStream all = new MemoryStream();
                for (;;) {
                    byte[] b = new byte[16384];
                    e = AdsSyncReadWriteReqEx2(port, ref addr, FREAD, handle, (uint)b.Length, b, 0, new byte[0], out read);
                    if (e != 0) throw new BridgeError("ADS error " + e + " reading " + file);
                    all.Write(b, 0, (int)read);
                    if (read < b.Length || all.Length > 1 << 20) return all.ToArray();
                }
            } finally { AdsSyncWriteReqEx(port, ref addr, FCLOSE, handle, 0, new byte[0]); }
        }
    }

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

    // The windows of XAE for the trial license: the button on its License page, and the dialog the button opens.
    static class Win {
        public delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

        public static string Text(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
        static string Class(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }

        public static int Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return (int)p; }

        public static void Front(IntPtr h) {
            if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);
            SetForegroundWindow(h);
        }

        static List<IntPtr> TopLevel(int pid) {
            List<IntPtr> found = new List<IntPtr>();
            EnumWindows(delegate(IntPtr h, IntPtr l) {
                if (IsWindowVisible(h) && Pid(h) == pid) found.Add(h);
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // An enabled, visible button of the process whose text has these words ("7 Days Trial License...").
        public static IntPtr Button(int pid, string words) {
            IntPtr button = IntPtr.Zero;
            foreach (IntPtr top in TopLevel(pid)) {
                EnumChildWindows(top, delegate(IntPtr c, IntPtr l) {
                    if (IsWindowVisible(c) && IsWindowEnabled(c) && Class(c).IndexOf("button", StringComparison.OrdinalIgnoreCase) >= 0
                            && Text(c).Replace("&", "").IndexOf(words, StringComparison.OrdinalIgnoreCase) >= 0) {
                        button = c;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
                if (button != IntPtr.Zero) break;
            }
            return button;
        }

        // BM_CLICK, posted: a click that returns at once, while the dialog it opens waits for the user.
        public static void Click(IntPtr button) { PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); }

        // A window of the process that disables the window owning it: the dialog the click opened.
        public static IntPtr Dialog(int pid, IntPtr main) {
            foreach (IntPtr top in TopLevel(pid)) {
                IntPtr owner = GetWindow(top, 4 /* GW_OWNER */);
                if (top != main && owner != IntPtr.Zero && !IsWindowEnabled(owner)) return top;
            }
            return IntPtr.Zero;
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

        // The declarations and implementations of an item and of everything below it (a POU with its folders and
        // members), by their path below it ("" for the item, "Speed^Get" for an accessor).
        static void Texts(ITcSmTreeItem item, string path, List<object> list) {
            Dictionary<string, object> e = new Dictionary<string, object>();
            e["path"] = path;
            ITcPlcDeclaration d = item as ITcPlcDeclaration;
            if (d != null) { try { e["decl"] = Normalize(d.DeclarationText); } catch { } }
            ITcPlcImplementation i = item as ITcPlcImplementation;
            if (i != null) { try { e["impl"] = Normalize(i.ImplementationText); } catch { } }
            list.Add(e);
            for (int k = 1; k <= item.ChildCount; k++) {
                ITcSmTreeItem c = item.get_Child(k);
                Texts(c, path.Length == 0 ? c.Name : path + "^" + c.Name, list);
            }
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

        // ------------------------------------------------------------------ PLC project file

        // A PLC project's .plcproj has no Project of its own in DTE: XAE keeps it in its running document table, as an
        // item of the TwinCAT project, with the PLC project itself as the document. CreateChild and DeleteChild of an
        // object leave it unsaved.
        static IVsRunningDocumentTable DocumentTable(DTE2 dte) {
            Guid sid = new Guid("a928aa21-ea77-47ac-8a07-355206c94bdd");
            Guid iid = typeof(IVsRunningDocumentTable).GUID;
            IntPtr p;
            int hr = ((IOleServiceProvider)dte).QueryService(ref sid, ref iid, out p);
            if (hr != 0 || p == IntPtr.Zero) throw new BridgeError("TwinCAT XAE gave no running document table");
            try { return (IVsRunningDocumentTable)Marshal.GetObjectForIUnknown(p); } finally { Marshal.Release(p); }
        }

        static bool DocDirty(IntPtr docData) {
            object o = Marshal.GetObjectForIUnknown(docData);
            int dirty;
            IVsPersistDocData d = o as IVsPersistDocData;
            if (d != null && d.IsDocDataDirty(out dirty) == 0) return dirty != 0;
            IPersistFileFormat f = o as IPersistFileFormat;
            if (f != null && f.IsDirty(out dirty) == 0) return dirty != 0;
            return false;
        }

        // Whether XAE has the project file in its table, and has changes to it that are not saved. With save, saves it
        // first when it has: RDTSAVEOPT_SaveNoChildren saves the file alone, without the unsaved edits of the PLC
        // project's editors (which a save of the file with its children writes too) and without the .tsproj.
        static Dictionary<string, object> ProjectFile(DTE2 dte, string file, bool save, bool force = false) {
            Dictionary<string, object> state = new Dictionary<string, object>();
            IVsRunningDocumentTable rdt = DocumentTable(dte);
            IntPtr hier, data; uint item, cookie;
            int hr = rdt.FindAndLockDocument(0 /* RDT_NoLock */, Path.GetFullPath(file), out hier, out item, out data, out cookie);
            try {
                state["open"] = hr == 0 && cookie != 0 && data != IntPtr.Zero;
                state["dirty"] = false;
                if (!(bool)state["open"]) return state;
                state["dirty"] = DocDirty(data);
                if (save && (force || (bool)state["dirty"])) {
                    hr = rdt.SaveDocuments(force ? 6u /* RDTSAVEOPT_ForceSave | RDTSAVEOPT_SaveNoChildren */ : 4u /* RDTSAVEOPT_SaveIfDirty | RDTSAVEOPT_SaveNoChildren */, hier, item, cookie);
                    if (hr != 0) throw new BridgeError("TwinCAT XAE did not save " + file + " (0x" + hr.ToString("x8") + ")");
                    state["dirty"] = DocDirty(data);
                }
                return state;
            } finally {
                if (hier != IntPtr.Zero) Marshal.Release(hier);
                if (data != IntPtr.Zero) Marshal.Release(data);
            }
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

        // ------------------------------------------------------------------ trial license

        const string SolutionExplorerKind = "{3AE79031-E1BC-11D0-8F78-00A0C9110057}";

        static Project ProjectOf(DTE2 dte, string tsproj) {
            foreach (Project p in dte.Solution.Projects) {
                try {
                    if (p.Object is ITcSysManager && string.Equals(Path.GetFullPath(p.FullName), Path.GetFullPath(tsproj), StringComparison.OrdinalIgnoreCase)) return p;
                } catch { }
            }
            throw new BridgeError("TwinCAT XAE has no project " + tsproj + " open");
        }

        static UIHierarchyItem HierarchyChild(UIHierarchyItem parent, string name) {
            parent.UIHierarchyItems.Expanded = true;
            List<string> names = new List<string>();
            foreach (UIHierarchyItem c in parent.UIHierarchyItems) {
                if (string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)) return c;
                names.Add(c.Name);
            }
            throw new BridgeError("Solution Explorer has no " + name + " under " + parent.Name + ", only " + string.Join(", ", names.ToArray()));
        }

        // SYSTEM > License of the TwinCAT project, opened as a double-click in Solution Explorer does.
        static void OpenLicensePage(DTE2 dte, string projectName) {
            dte.Windows.Item(SolutionExplorerKind).Activate();
            UIHierarchy tree = dte.ToolWindows.SolutionExplorer;
            UIHierarchyItem license = HierarchyChild(HierarchyChild(HierarchyChild(tree.UIHierarchyItems.Item(1), projectName), "SYSTEM"), "License");
            license.Select(vsUISelectionType.vsUISelectionTypeSelect);
            tree.DoDefaultAction();
        }

        // TwinCAT XAE started on a solution, in front: the user's to see and to close, so that it stays open when the
        // bridge ends. Returns once the solution is open.
        static DTE2 Start(string progId, string sln) {
            Type type = Type.GetTypeFromProgID(progId);
            if (type == null) throw new BridgeError(progId + " is not registered");
            DTE2 dte = (DTE2)Activator.CreateInstance(type);
            dte.UserControl = true;
            dte.MainWindow.Visible = true;
            Win.Front(new IntPtr(dte.MainWindow.HWnd));
            dte.Solution.Open(sln);
            return dte;
        }

        // XAE with the TwinCAT project targeting netId, SYSTEM > License open and "7 Days Trial License..." clicked: its
        // dialog then waits for the user to type the security code. A running XAE (pid) keeps its target unless setTarget
        // is given, or else the answer is needsTarget; an XAE started here (progId, sln) takes netId at once. Either stays
        // open for the user to close, also when the bridge ends; a target changed here goes back if the License page does
        // not open.
        static object OpenTrialLicense(Dictionary<string, object> r) {
            Dictionary<string, object> a = new Dictionary<string, object>();
            bool started = !r.ContainsKey("pid");
            DTE2 dte = started ? Start(Str(r, "progId"), Str(r, "sln")) : Dte(Int(r, "pid"));
            IntPtr main = new IntPtr(dte.MainWindow.HWnd);
            int pid = Win.Pid(main);
            a["pid"] = pid;
            a["hwnd"] = main.ToInt64();
            a["started"] = started;
            Project project = ProjectOf(dte, Str(r, "tsproj"));
            ITcSysManager4 sm = (ITcSysManager4)project.Object;
            string netId = Str(r, "netId");
            string target = sm.GetTargetNetId();
            a["target"] = target;
            if (netId != null && !string.Equals(target, netId, StringComparison.OrdinalIgnoreCase)) {
                if (!started && !(r.ContainsKey("setTarget") && Convert.ToBoolean(r["setTarget"]))) {
                    a["needsTarget"] = true;
                    return a;
                }
                sm.SetTargetNetId(netId);
                a["targetChanged"] = true;
            }
            try {
                OpenLicensePage(dte, project.Name);
            } catch {
                if (a.ContainsKey("targetChanged")) try { sm.SetTargetNetId(target); } catch { }
                throw;
            }
            Win.Front(main);
            IntPtr button = IntPtr.Zero;
            for (DateTime end = DateTime.Now.AddSeconds(60); button == IntPtr.Zero && DateTime.Now < end; ) {
                System.Threading.Thread.Sleep(500);
                button = Win.Button(pid, "Trial License");
            }
            a["clicked"] = button != IntPtr.Zero;
            if (button == IntPtr.Zero) return a;
            Win.Click(button);
            IntPtr dialog = IntPtr.Zero;
            for (DateTime end = DateTime.Now.AddSeconds(30); dialog == IntPtr.Zero && DateTime.Now < end; ) {
                System.Threading.Thread.Sleep(250);
                dialog = Win.Dialog(pid, main);
            }
            if (dialog != IntPtr.Zero) {
                Win.Front(dialog);
                // Its title only: the security code is for the user to read.
                a["dialog"] = Win.Text(dialog);
            }
            return a;
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
                case "texts": {
                    // XAE's code of a POU and its members, with any unsaved edits: DTE's documents do not show the
                    // PLC editors, so their saved state is told by comparing these texts with the file.
                    List<object> list = new List<object>();
                    Texts(Item(r), "", list);
                    return list;
                }
                case "save": {
                    // Saves the documents of one file that still have unsaved changes. XAE saves a POU's file itself
                    // after CreateChild, DeleteChild and a set text; the TwinCAT project is never saved here: saving it
                    // rewrites the .tsproj, its process image included. A .plcproj is saved by "project".
                    DTE2 dte = Dte(Int(r, "pid"));
                    string full = Path.GetFullPath(Str(r, "file"));
                    int saved = 0;
                    foreach (Document d in dte.Documents) {
                        string name;
                        try { name = d.FullName; } catch { continue; }
                        if (!string.Equals(Path.GetFullPath(name), full, StringComparison.OrdinalIgnoreCase)) continue;
                        bool dirty;
                        try { dirty = !d.Saved; } catch { dirty = true; }
                        if (!dirty) continue;
                        d.Save();
                        saved++;
                    }
                    Dictionary<string, object> a = DocState(dte, full);
                    a["saved"] = saved;
                    return a;
                }
                case "project":
                    // A PLC project's .plcproj: its unsaved state, saved alone first when save is given.
                    return ProjectFile(Dte(Int(r, "pid")), Str(r, "file"), r.ContainsKey("save") && Convert.ToBoolean(r["save"]),
                        r.ContainsKey("force") && Convert.ToBoolean(r["force"]));
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
                case "openTrialLicense":
                    return OpenTrialLicense(r);
                case "open": {
                    // XAE started on the solution of a project, as the user asks: theirs, never closed or saved here.
                    DTE2 dte = Start(Str(r, "progId"), Str(r, "sln"));
                    Dictionary<string, object> a = new Dictionary<string, object>();
                    a["pid"] = Win.Pid(new IntPtr(dte.MainWindow.HWnd));
                    return a;
                }
                case "front": {
                    // The main window of an XAE in front, as the user asks, without a COM call: a busy XAE comes too. An
                    // XAE a tool started hidden has none, and stays hidden.
                    int pid = Int(r, "pid");
                    IntPtr main;
                    try { main = System.Diagnostics.Process.GetProcessById(pid).MainWindowHandle; }
                    catch (ArgumentException) { throw new BridgeError("TwinCAT XAE (process " + pid + ") is no longer running"); }
                    if (main != IntPtr.Zero) Win.Front(main);
                    Dictionary<string, object> a = new Dictionary<string, object>();
                    a["shown"] = main != IntPtr.Zero;
                    return a;
                }
                case "target":
                    // Sets the target of a TwinCAT project back, after openTrialLicense changed it.
                    ((ITcSysManager4)ProjectOf(Dte(Int(r, "pid")), Str(r, "tsproj")).Object).SetTargetNetId(Str(r, "netId"));
                    return new Dictionary<string, object>();
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
                case "adsRoutes":
                    return Ads.Routes();
                case "adsLicenses":
                    return Ads.Licenses(Str(r, "netId"));
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
                if (Str(request, "cmd") == "window") {
                    // Whether an XAE still runs, and whether a dialog (which disables it) is open: no COM call, so it
                    // answers while XAE is busy.
                    IntPtr h = new IntPtr(Convert.ToInt64(request["hwnd"]));
                    Dictionary<string, object> w = new Dictionary<string, object>();
                    w["running"] = Win.IsWindow(h);
                    w["enabled"] = Win.IsWindow(h) && Win.IsWindowEnabled(h);
                    Dictionary<string, object> a = new Dictionary<string, object>();
                    a["id"] = request["id"]; a["ok"] = true; a["result"] = w;
                    Write(a);
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
                // A request for no XAE in particular (instances) is blocked by a dialog of any of them.
                List<string> dialogs = new List<string>();
                if (request.ContainsKey("pid")) dialogs.AddRange(Dialogs.Of(Int(request, "pid")));
                else foreach (string exe in new[] { "TcXaeShell", "devenv" }) foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName(exe)) dialogs.AddRange(Dialogs.Of(p.Id));
                late["dialogs"] = dialogs;
                Write(late);
                // The worker is stuck in a COM call: end the process so that the call ends with it.
                Environment.Exit(2);
            }
        }
    }
}
