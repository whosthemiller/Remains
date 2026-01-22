/**
 * Main entry point for the app
 * Creates/selects canvas and starts the Drawer scene
 */
import { DrawerScene } from './scenes/drawer.js';

function init() {
  const canvas = document.getElementById('canvas');
  
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }
  
  // Create and initialize the Drawer scene
  const drawerScene = new DrawerScene(canvas);
  drawerScene.initialize();
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
