const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:            () => ipcRenderer.send('minimize-window'),
  maximize:            () => ipcRenderer.send('maximize-window'),
  close:               () => ipcRenderer.send('close-window'),
  fetchPage:           (url)       => ipcRenderer.invoke('fetch-page', url),
  fetchImage:          (url)       => ipcRenderer.invoke('fetch-image', url),
  proxyVideo:          (url)       => ipcRenderer.invoke('proxy-video', url),
  extractVideoUrl:     (url)       => ipcRenderer.invoke('extract-video-url', url),
  fetchGofile:         (contentId) => ipcRenderer.invoke('fetch-gofile', contentId),
  loadGofileList:      ()          => ipcRenderer.invoke('load-gofile-list'),
  fetchGithubFilelist: ()          => ipcRenderer.invoke('fetch-github-filelist'),
  fetchGithubFile:     (url)       => ipcRenderer.invoke('fetch-github-file', url),
  fetchAnilistTitles:  (title)     => ipcRenderer.invoke('fetch-anilist-titles', title),
});