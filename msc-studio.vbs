' Opens Music Studio in its own window, without the black server window.
' (abrir-app.cmd still opens it the old way, with the log visible, for troubleshooting.)
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
On Error Resume Next
sh.Run "node """ & dir & "\src\cli.mjs"" app --janela", 0, False
If Err.Number <> 0 Then MsgBox "Node.js nao foi encontrado. Rode instalar.cmd e tente de novo.", 16, "Music Studio"
