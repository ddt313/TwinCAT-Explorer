# Demo: a TwinCAT solution saved by TwinCAT XAE

A small TwinCAT 3 solution to try the extension on, to run the scripts and the MCP server against (`--root samples/Demo`), and to compare against the files XAE writes. All names and code are made up.

- **Written by:** TwinCAT XAE 3.1.4026.27 (`TcXaeShell.DTE.15.0`), driven through the TwinCAT Automation Interface. Every file is as XAE saved it: CRLF, BOM, its XML layout. Change the files in XAE, never by hand. `.gitattributes` keeps git from changing their line endings (`samples/** -text`).
- **Builds:** XAE's Build Solution gives 0 errors and 0 warnings for both PLC projects.

## What it holds

`Demo.sln` → `Demo/Demo.tsproj`, with two PLC projects:

**DemoLib** (`Demo/DemoLib`): a PLC project with no task, saved as the library `DemoLib` (Company `Demo`, version 1.0.0.0).

| Object | Kind |
| --- | --- |
| `E_ValveState` | enum, `qualified_only` and `strict` |
| `ST_ValveStatus` | struct |
| `U_Word` | union |
| `T_Percent` | alias of `LREAL` |
| `GVL_DemoLib` | GVL, `VAR_GLOBAL CONSTANT`, `qualified_only` |
| `POUs/Valves/I_Valve` | interface: methods `Open`, `Close`, property `State` (Get) |
| `POUs/Valves/FB_ValveBase` | `FUNCTION_BLOCK ABSTRACT ... IMPLEMENTS I_Valve`: methods, property with Get only |
| `F_Clamp` | function |

**Machine** (`Demo/Machine`): the application. It references the library `DemoLib` (`<LibraryReference Include="DemoLib,newest,Demo">`), plus Tc2_Standard, Tc2_System, Tc3_Module.

| Object | Kind |
| --- | --- |
| `E_FillStep` | enum with a base type (`UINT`) |
| `ST_Recipe` | struct, uses `T_Percent` from DemoLib |
| `GVL_IO` | GVL with `AT %I*` / `AT %Q*` |
| `GVL_Parameters` | GVL, `VAR_GLOBAL PERSISTENT` |
| `POUs/Equipment/FB_Valve` | `EXTENDS FB_ValveBase`: overrides `Open` with `SUPER^`, action `A_Reset` |
| `POUs/Equipment/FB_Conveyor` | property `Speed` (Get and Set), methods `Start`, `Stop` |
| `POUs/Sequences/FB_FillSequence` | a `CASE` step sequence, takes an `I_Valve` |
| `PRG_Lamp` | program in CFC (not ST) |
| `POUs/Experimental/FB_Prototype` | in a folder set to **Exclude from build**. Its code names an unknown symbol on purpose, to show how a tool treats excluded code. Nothing calls it, and the build passes |
| `MAIN` | program called by `PlcTask` |

## Opening it in XAE

Machine needs the library `DemoLib` installed. If XAE reports it missing: Library Repository → Install → `samples/Demo/Libraries/DemoLib.library`. `Libraries/DemoLib.library` was saved from the DemoLib project. Save it again after changing DemoLib.

XAE writes `_Boot`, `_CompileInfo`, `_Libraries` and `.vs` on build: `.gitignore` keeps them out. A build also rewrites the `.tmc` files. Commit them only with a change that needs them.

## Checked by the tests

`test/unit/sample.test.ts` (`npm run test:unit`) checks that the extension reads the sample as XAE builds it: both PLC projects with every file of them, no syntax error, and no problem but the unknown name in `FB_Prototype` (the extension does not read *Exclude from build* yet). It also checks that the files have the bytes XAE wrote, also after a section is edited and edited back. After changing the sample in XAE, run the tests: a problem found outside excluded code is the extension's own.

To look at it from the command line (after `npm run compile`):

```bash
node scripts/analyze-all.js samples/Demo --list 20
node scripts/mcp-call.js samples/Demo check read '{"object":"FB_Valve.Open"}'
```
