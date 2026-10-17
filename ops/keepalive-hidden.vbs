' Launch the keepalive with no console window.
'
' Task Scheduler gives a console app a window even with -WindowStyle Hidden, and
' this one loops forever, so the window sat on the desktop for as long as it ran.
' WScript.Shell.Run with mode 0 is the one way to start it with no window at all.
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\blakm\koharu-port\ops\keepalive.ps1""", 0, False
