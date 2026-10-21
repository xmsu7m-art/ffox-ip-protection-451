' Start the Guardian token shim silently (no console window).
' Logs are appended to shim.log in the repository root.
' Requires Python 3 on PATH (pythonw.exe).

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "pythonw ""scripts\guardian-shim.py"" --port 8787 --log shim.log", 0, False
