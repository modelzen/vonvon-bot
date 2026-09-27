import {createRoot} from 'react-dom/client';
import {App} from './App';
import './reference/App.css';
import './collaboration.css';
import './desktop.css';
const root=document.getElementById('root');
if(!root)throw new Error('Application root missing.');
createRoot(root).render(<App/>);
