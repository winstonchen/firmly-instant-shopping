// Service worker: opens the side panel from the toolbar icon.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('sidePanel behavior', err));
