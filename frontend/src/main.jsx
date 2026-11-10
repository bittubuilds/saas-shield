import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './fonts.css';
import './styles.css';

document.documentElement.classList.add('has-js');

createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter basename="/app"><App /></BrowserRouter></React.StrictMode>
);
