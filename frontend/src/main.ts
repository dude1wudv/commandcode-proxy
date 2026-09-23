import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import './console-theme.css';
import { initAppearance } from './useAppearance';
initAppearance();
createApp(App).mount('#app');
