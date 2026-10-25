' Start ops\llm-tunnel.ps1 with no window. The script holds a mutex, so a run
' while the tunnel is already up exits at once; this task can fire freely.
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\blakm\koharu-port\ops\llm-tunnel.ps1""", 0, False
