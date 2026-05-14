  playMpv:           (url)  => ipcRenderer.invoke('play-mpv', url),
  stopMpv:           ()     => ipcRenderer.send('stop-mpv'),