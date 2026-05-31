Option Explicit
Dim shell, fso, root
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
WScript.Sleep 15000
shell.CurrentDirectory = root
shell.Run """" & root & "\START_BOT.bat""", 7, False
