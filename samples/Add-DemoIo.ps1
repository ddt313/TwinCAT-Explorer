<#
.SYNOPSIS
  Adds I/O to samples/Demo through TwinCAT XAE's Automation Interface: an EtherCAT master with an EK1100, EL1008,
  EL2008 and EL3064 (offline, no hardware needed), new PLC variables with AT %I* / %Q*, and links between them, some
  left unlinked on purpose. XAE writes every file, as the README of samples/Demo requires.

.DESCRIPTION
  Run once, on Windows with TwinCAT XAE 3.1.4026 (TcXaeShell) and the library DemoLib installed (see
  samples/Demo/README.md), in Windows PowerShell 5.1 (STA, the default of powershell.exe):

      powershell -ExecutionPolicy Bypass -File samples\Add-DemoIo.ps1

  It starts its own XAE, opens Demo.sln, and stops with a message if the solution already has the I/O (it does not
  undo anything: start again from a clean checkout, `git checkout -- samples/Demo` then `git clean -fd samples/Demo`).

  What it adds (Machine):
    DUTs\ST_DriveIn                 struct: bReady, bFault, nVelocity
    POUs\Equipment\FB_Sensor        FB with   bSignal AT %I* : BOOL   inside, so its link is per instance
    GVL_IO                          + stDrive AT %I* : ST_DriveIn, aLamps AT %Q* : ARRAY[1..3] OF BOOL, bSpareOut AT %Q* : BOOL
    MAIN                            + fbSensorLeft, fbSensorRight : FB_Sensor, called at the end (line numbers of the
                                      existing code stay as test/unit/sample.test.ts expects)

  I/O: Device 1 (EtherCAT) > Term 1 (EK1100) > Term 2 (EL1008), Term 3 (EL2008), Term 4 (EL3064)

  Links (PLC variable -> terminal channel):
    GVL_IO.bStartButton          -> Term 2 (EL1008)  Channel 1^Input
    MAIN.fbSensorLeft.bSignal    -> Term 2 (EL1008)  Channel 2^Input
    GVL_IO.stDrive.bReady        -> Term 2 (EL1008)  Channel 3^Input
    GVL_IO.stDrive.bFault        -> Term 2 (EL1008)  Channel 4^Input
    GVL_IO.nLevelRaw             -> Term 4 (EL3064)  AI Standard Channel 1^Value
    GVL_IO.bInletOpen            -> Term 3 (EL2008)  Channel 1^Output
    GVL_IO.bConveyorRun          -> Term 3 (EL2008)  Channel 2^Output
    GVL_IO.aLamps[1]             -> Term 3 (EL2008)  Channel 3^Output
    GVL_IO.aLamps[2]             -> Term 3 (EL2008)  Channel 4^Output
  Not linked, on purpose: MAIN.fbSensorRight.bSignal (one instance of two), GVL_IO.stDrive.nVelocity (part of a
  struct), GVL_IO.aLamps[3] (part of an array), GVL_IO.bSpareOut (a whole variable).

  Afterwards, by hand in XAE (the Automation Interface has no call for it): right-click "Device 1 (EtherCAT)" >
  "Independent Project File", so that the device is saved in _Config\IO\Device 1 (EtherCAT).xti, then Save All.
  Then build both PLC projects (0 errors, 0 warnings), run `npm run test:unit`, and update samples/Demo/README.md.

.PARAMETER Solution
  The solution to change. Default: Demo\Demo.sln next to this script.

.PARAMETER KeepOpen
  Leave XAE open afterwards, to look at the result or do the manual step above.
#>
param(
    [string]$Solution = (Join-Path $PSScriptRoot 'Demo\Demo.sln'),
    [switch]$KeepOpen
)
$ErrorActionPreference = 'Stop'

if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    throw 'Run this in Windows PowerShell 5.1 (powershell.exe), which runs in STA: the Automation Interface needs it.'
}
$Solution = (Resolve-Path $Solution).Path

$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $dirty = & git -C (Split-Path $Solution) status --porcelain -- . 2>$null
    if ($dirty) { Write-Warning "samples/Demo has uncommitted changes:`n$($dirty -join "`n")" }
}

# --------------------------------------------------------------------------------------------- the XAE installed here
# As src/core/xae.ts finds it: the ProgID registered for COM, its PublicAssemblies, TCatSysManagerLib from the GAC.
function RegDefault([string]$key) {
    try { return (Get-Item -LiteralPath "Registry::$key").GetValue('') } catch { return $null }
}
$progId = $null; $publicAssemblies = $null
foreach ($id in 'TcXaeShell.DTE.17.0', 'TcXaeShell.DTE.15.0') {
    $clsid = RegDefault "HKEY_CLASSES_ROOT\$id\CLSID"
    if (-not $clsid) { continue }
    foreach ($view in 'HKEY_CLASSES_ROOT\CLSID', 'HKEY_CLASSES_ROOT\WOW6432Node\CLSID') {
        $server = RegDefault "$view\$clsid\LocalServer32"
        if ($server -and $server -match '^\s*"?([^"]+?\.exe)') {
            $dir = Join-Path (Split-Path $Matches[1]) 'PublicAssemblies'
            if ((Test-Path (Join-Path $dir 'envdte.dll')) -and (Test-Path (Join-Path $dir 'envdte80.dll'))) {
                $progId = $id; $publicAssemblies = $dir; break
            }
        }
    }
    if ($progId) { break }
}
if (-not $progId) { throw 'TwinCAT XAE (TcXaeShell) is not registered on this machine.' }
$gac = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\TCatSysManagerLib'
$sysManager = Get-ChildItem $gac -Recurse -Filter 'TCatSysManagerLib.dll' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $sysManager) { throw 'TCatSysManagerLib.dll is not in the GAC: is TwinCAT XAE installed?' }

$refs = @((Join-Path $publicAssemblies 'envdte.dll'), (Join-Path $publicAssemblies 'envdte80.dll'), $sysManager)
foreach ($r in $refs) { [void][Reflection.Assembly]::LoadFrom($r) }

# ---------------------------------------------------------------------------------------------------------- the work
# C# 5 (what Add-Type of Windows PowerShell compiles): explicit casts to the TwinCAT interfaces, which PowerShell's
# late binding of COM objects does not reach.
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using EnvDTE;
using EnvDTE80;
using TCatSysManagerLib;

namespace DemoIo {

    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleMessageFilter {
        [PreserveSig] int HandleInComingCall(int callType, IntPtr callerTask, int tickCount, IntPtr interfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr calleeTask, int tickCount, int rejectType);
        [PreserveSig] int MessagePending(IntPtr calleeTask, int tickCount, int pendingType);
    }

    // XAE rejects calls while it is busy (opening the solution, building): retried every 100 ms, for up to 2 minutes.
    class MessageFilter : IOleMessageFilter {
        [DllImport("ole32.dll")] static extern int CoRegisterMessageFilter(IOleMessageFilter f, out IOleMessageFilter old);
        public static void Register() { IOleMessageFilter old; CoRegisterMessageFilter(new MessageFilter(), out old); }
        public static void Revoke() { IOleMessageFilter old; CoRegisterMessageFilter(null, out old); }
        int IOleMessageFilter.HandleInComingCall(int a, IntPtr b, int c, IntPtr d) { return 0; }
        int IOleMessageFilter.RetryRejectedCall(IntPtr a, int tick, int type) { return type == 2 && tick < 120000 ? 100 : -1; }
        int IOleMessageFilter.MessagePending(IntPtr a, int b, int c) { return 2; }
    }

    public static class Runner {
        const int SubFolder = 601, SubFb = 604, SubStruct = 606;
        const int IecSt = 1;                       // IECLANGUAGETYPES.IECLANGUAGE_ST, as src/mcp/live.ts passes it
        const int SubEtherCatMaster = 111, SubEtherCatBox = 9099;

        const string Plc = "TIPC^Machine";
        const string PlcProject = "TIPC^Machine^Machine Project";
        const string Inputs = "TIPC^Machine^Machine Instance^PlcTask Inputs";
        const string Outputs = "TIPC^Machine^Machine Instance^PlcTask Outputs";

        static ITcSysManager sm;

        static void Log(string s) { Console.WriteLine(s); }

        static ITcSmTreeItem TryLookup(string path) {
            try { return sm.LookupTreeItem(path); } catch (COMException) { return null; } catch (ArgumentException) { return null; }
        }

        static ITcSmTreeItem Lookup(string path) {
            ITcSmTreeItem item = TryLookup(path);
            if (item == null) throw new Exception("XAE has no " + path + ChildrenHint(path));
            return item;
        }

        // The children of the nearest item above a path that XAE has, to show what the path should have been.
        static string ChildrenHint(string path) {
            int i = path.LastIndexOf('^');
            while (i > 0) {
                string parent = path.Substring(0, i);
                ITcSmTreeItem p = TryLookup(parent);
                if (p != null) {
                    StringBuilder b = new StringBuilder("\n  " + parent + " has:");
                    for (int k = 1; k <= p.ChildCount; k++) b.Append("\n    " + p.get_Child(k).Name);
                    return b.ToString();
                }
                i = parent.LastIndexOf('^');
            }
            return "";
        }

        // ------------------------------------------------------------------------------------------- PLC code

        static string InsertBeforeLastEndVar(string decl, string lines) {
            int i = decl.LastIndexOf("END_VAR", StringComparison.Ordinal);
            if (i < 0) throw new Exception("No END_VAR in:\n" + decl);
            return decl.Substring(0, i) + lines + decl.Substring(i);
        }

        static void AddPlcCode() {
            ITcSmTreeItem duts = Lookup(PlcProject + "^DUTs");
            ITcSmTreeItem st = duts.CreateChild("ST_DriveIn", SubStruct, "", null);
            ((ITcPlcDeclaration)st).DeclarationText =
                "TYPE ST_DriveIn :\r\nSTRUCT\r\n" +
                "\tbReady\t\t: BOOL;\r\n" +
                "\tbFault\t\t: BOOL;\r\n" +
                "\tnVelocity\t: INT;\r\n" +
                "END_STRUCT\r\nEND_TYPE\r\n";
            Log("  DUTs\\ST_DriveIn");

            ITcSmTreeItem equipment = Lookup(PlcProject + "^POUs^Equipment");
            ITcSmTreeItem fb = equipment.CreateChild("FB_Sensor", SubFb, "", new object[] { IecSt });
            ((ITcPlcDeclaration)fb).DeclarationText =
                "FUNCTION_BLOCK FB_Sensor\r\n" +
                "VAR_OUTPUT\r\n\tbActive\t: BOOL;\r\nEND_VAR\r\n" +
                "VAR\r\n\tbSignal\tAT %I*\t: BOOL;\r\nEND_VAR\r\n";
            ((ITcPlcImplementation)fb).ImplementationText = "bActive := bSignal;\r\n";
            Log("  POUs\\Equipment\\FB_Sensor");

            ITcSmTreeItem gvl = Lookup(PlcProject + "^GVLs^GVL_IO");
            ITcPlcDeclaration gvlDecl = (ITcPlcDeclaration)gvl;
            gvlDecl.DeclarationText = InsertBeforeLastEndVar(gvlDecl.DeclarationText,
                "\tstDrive\t\t\tAT %I*\t: ST_DriveIn;\r\n" +
                "\taLamps\t\t\tAT %Q*\t: ARRAY[1..3] OF BOOL;\r\n" +
                "\tbSpareOut\t\tAT %Q*\t: BOOL;\t// spare: not linked\r\n");
            Log("  GVL_IO: stDrive, aLamps, bSpareOut");

            ITcSmTreeItem main = Lookup(PlcProject + "^POUs^MAIN");
            ITcPlcDeclaration mainDecl = (ITcPlcDeclaration)main;
            mainDecl.DeclarationText = InsertBeforeLastEndVar(mainDecl.DeclarationText,
                "\tfbSensorLeft\t: FB_Sensor;\r\n" +
                "\tfbSensorRight\t: FB_Sensor;\r\n");
            ITcPlcImplementation mainImpl = (ITcPlcImplementation)main;
            string impl = mainImpl.ImplementationText.TrimEnd('\r', '\n') + "\r\n";
            mainImpl.ImplementationText = impl +
                "\r\n" +
                "fbSensorLeft();\r\n" +
                "fbSensorRight();\r\n" +
                "GVL_IO.aLamps[1] := fbSensorLeft.bActive;\r\n" +
                "GVL_IO.aLamps[2] := fbSensorRight.bActive;\r\n" +
                "GVL_IO.aLamps[3] := GVL_IO.stDrive.bReady AND NOT GVL_IO.stDrive.bFault AND GVL_IO.stDrive.nVelocity > 0;\r\n";
            Log("  MAIN: fbSensorLeft, fbSensorRight");
        }

        static void BuildPlc() {
            ITcPlcProject plc = (ITcPlcProject)Lookup(Plc);
            try { plc.CompileProject(); }
            catch (COMException e) { throw new Exception("Building Machine failed: see XAE's Error List. " + e.Message); }
            // The instance takes the new variables from the .tmc the build wrote (ReloadTmc="true").
            for (int i = 0; i < 100 && TryLookup(Inputs + "^GVL_IO.stDrive") == null; i++) System.Threading.Thread.Sleep(100);
            Lookup(Inputs + "^GVL_IO.stDrive");
        }

        // ------------------------------------------------------------------------------------------------ I/O

        // An EtherCAT box from the ESI files of this XAE: the product code alone takes its newest revision; if XAE
        // refuses that, the revisions XAE 3.1.4026 usually ships.
        static ITcSmTreeItem AddBox(ITcSmTreeItem parent, string name, string type) {
            string[] tries = { type, type + "-0000-0017", type + "-0000-0016", type + "-0000-0018", type + "-0000-0019", type + "-0000-0020" };
            Exception last = null;
            foreach (string t in tries) {
                try {
                    ITcSmTreeItem box = parent.CreateChild(name, SubEtherCatBox, "", t);
                    if (box != null) { Log("  " + box.PathName + "  (" + t + ")"); return box; }
                } catch (Exception e) { last = e; }
            }
            throw new Exception("XAE could not add " + type + " (no ESI file for it?): " + (last != null ? last.Message : ""));
        }

        static Dictionary<string, string> AddIo() {
            ITcSmTreeItem io = Lookup("TIID");
            ITcSmTreeItem master = io.CreateChild("Device 1 (EtherCAT)", SubEtherCatMaster, "", null);
            Log("  " + master.PathName);
            ITcSmTreeItem coupler = AddBox(master, "Term 1 (EK1100)", "EK1100");
            Dictionary<string, string> t = new Dictionary<string, string>();
            t["EL1008"] = AddBox(coupler, "Term 2 (EL1008)", "EL1008").PathName;
            t["EL2008"] = AddBox(coupler, "Term 3 (EL2008)", "EL2008").PathName;
            t["EL3064"] = AddBox(coupler, "Term 4 (EL3064)", "EL3064").PathName;
            return t;
        }

        // The item of a PLC variable in the process image. A struct member or an array element is a child of its
        // variable; XAE names such children in more than one way, so the usual forms are tried.
        static string PlcVar(string group, string name) {
            List<string> tries = new List<string>();
            tries.Add(group + "^" + name);
            int dot = name.LastIndexOf('.');
            int br = name.IndexOf('[');
            if (br > 0) {
                string whole = name.Substring(0, br), elem = name.Substring(br);
                string shortName = whole.Substring(whole.LastIndexOf('.') + 1);
                tries.Add(group + "^" + whole + "^" + name);
                tries.Add(group + "^" + whole + "^" + shortName + elem);
                tries.Add(group + "^" + whole + "^" + elem);
            } else if (dot > 0 && name.IndexOf('.') != dot) {
                string whole = name.Substring(0, dot), member = name.Substring(dot + 1);
                tries.Add(group + "^" + whole + "^" + member);
                tries.Add(group + "^" + whole + "^" + name);
            }
            foreach (string p in tries) if (TryLookup(p) != null) return p;
            throw new Exception("XAE has none of:\n  " + string.Join("\n  ", tries.ToArray()) + ChildrenHint(tries[tries.Count - 1]));
        }

        static void Link(string group, string plcName, string terminal, string channel) {
            string a = PlcVar(group, plcName);
            string b = Lookup(terminal + "^" + channel).PathName;
            sm.LinkVariables(a, b);
            Log("  " + plcName + "  ->  " + b);
        }

        static void AddLinks(Dictionary<string, string> t) {
            Link(Inputs, "GVL_IO.bStartButton", t["EL1008"], "Channel 1^Input");
            Link(Inputs, "MAIN.fbSensorLeft.bSignal", t["EL1008"], "Channel 2^Input");
            Link(Inputs, "GVL_IO.stDrive.bReady", t["EL1008"], "Channel 3^Input");
            Link(Inputs, "GVL_IO.stDrive.bFault", t["EL1008"], "Channel 4^Input");
            Link(Inputs, "GVL_IO.nLevelRaw", t["EL3064"], "AI Standard Channel 1^Value");
            Link(Outputs, "GVL_IO.bInletOpen", t["EL2008"], "Channel 1^Output");
            Link(Outputs, "GVL_IO.bConveyorRun", t["EL2008"], "Channel 2^Output");
            Link(Outputs, "GVL_IO.aLamps[1]", t["EL2008"], "Channel 3^Output");
            Link(Outputs, "GVL_IO.aLamps[2]", t["EL2008"], "Channel 4^Output");
        }

        // -------------------------------------------------------------------------------------------- the run

        static ITcSysManager SysManagerOf(DTE2 dte) {
            foreach (Project p in dte.Solution.Projects) {
                ITcSysManager m = null;
                try { m = p.Object as ITcSysManager; } catch { }
                if (m != null && p.FullName.EndsWith("Demo.tsproj", StringComparison.OrdinalIgnoreCase)) return m;
            }
            throw new Exception("The solution has no Demo.tsproj");
        }

        public static void Run(string progId, string solution, bool keepOpen) {
            MessageFilter.Register();
            DTE2 dte = null;
            bool done = false;
            try {
                Log("Starting " + progId + " ...");
                dte = (DTE2)Activator.CreateInstance(Type.GetTypeFromProgID(progId, true));
                dte.SuppressUI = false;
                dte.MainWindow.Visible = true;
                dte.UserControl = keepOpen;
                Log("Opening " + solution);
                dte.Solution.Open(solution);
                sm = SysManagerOf(dte);

                if (TryLookup("TIID^Device 1 (EtherCAT)") != null || TryLookup(PlcProject + "^DUTs^ST_DriveIn") != null)
                    throw new Exception("The solution already has the I/O of this script. Start from a clean checkout of samples/Demo.");

                Log("PLC code (Machine):");
                AddPlcCode();
                Log("Building Machine ...");
                BuildPlc();
                Log("I/O:");
                Dictionary<string, string> terminals = AddIo();
                Log("Links:");
                AddLinks(terminals);
                Log("Saving ...");
                dte.ExecuteCommand("File.SaveAll", "");
                Log("Done. Not linked on purpose: MAIN.fbSensorRight.bSignal, GVL_IO.stDrive.nVelocity, GVL_IO.aLamps[3], GVL_IO.bSpareOut.");
                done = true;
                Log("Next, in XAE: Device 1 (EtherCAT) > right-click > Independent Project File, then Save All; build both PLC projects.");
            } finally {
                // After a failure XAE stays open, with what was done so far unsaved, to look at; close it without saving.
                if (dte != null && done && !keepOpen) { try { dte.Quit(); } catch { } }
                MessageFilter.Revoke();
            }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies $refs
[DemoIo.Runner]::Run($progId, $Solution, [bool]$KeepOpen)
