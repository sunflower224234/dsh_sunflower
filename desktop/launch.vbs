' DeepSeek Harness desktop launcher (no console window once ready).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = appDir & "\start.bat"
exe = appDir & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(exe) Then
    ret = sh.Run("""" & bat & """", 0, True)
Else
    ret = sh.Run("""" & bat & """", 1, True)
End If
If ret <> 0 Then
    MsgBox "DeepSeek Harness failed to start (code " & ret & ")." & vbCrLf & vbCrLf & _
           "Open a console and run the launcher manually to see details:" & vbCrLf & _
           "  " & bat, 16, "DeepSeek Harness"
End If
